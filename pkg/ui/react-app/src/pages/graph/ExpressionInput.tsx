import React, { FC, useEffect, useRef } from 'react';
import { Button, InputGroup, InputGroupAddon, InputGroupText } from 'reactstrap';
import { EditorView, highlightSpecialChars, keymap, ViewUpdate, placeholder } from '@codemirror/view';
import { EditorState, Prec, Compartment } from '@codemirror/state';
import { bracketMatching, indentOnInput, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { defaultKeymap, historyKeymap, history, insertNewlineAndIndent } from '@codemirror/commands';
import { highlightSelectionMatches } from '@codemirror/search';
import { lintKeymap } from '@codemirror/lint';
import { PromQLExtension, CompleteStrategy, newCompleteStrategy } from '@prometheus-io/codemirror-promql';
import {
  autocompletion,
  completionKeymap,
  CompletionContext,
  CompletionResult,
  closeBracketsKeymap,
  closeBrackets,
} from '@codemirror/autocomplete';
import { baseTheme, lightTheme, darkTheme, promqlHighlighter } from './CMTheme';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSearch, faSpinner } from '@fortawesome/free-solid-svg-icons';
import PathPrefixProps from '../../types/PathPrefixProps';
import { useTheme } from '../../contexts/ThemeContext';
import {
  HTTPPrometheusClient,
  MetricMetadata,
  PrometheusClient,
  PrometheusConfig,
} from '@prometheus-io/codemirror-promql/dist/esm/client/prometheus';
import { Matcher } from '@prometheus-io/codemirror-promql/dist/esm/types/matcher';
import { FetchFn } from '@prometheus-io/codemirror-promql/dist/esm/client';
import { labelMatchersToString } from '@prometheus-io/codemirror-promql/dist/esm/parser';

// These are status codes where the Prometheus API still returns a valid JSON body,
// with an error encoded within the JSON.
const badRequest = 400;
const unprocessableEntity = 422;
const serviceUnavailable = 503;

interface APIResponse<T> {
  status: 'success' | 'error';
  data?: T;
  error?: string;
  warnings?: string[];
}

export class CustomHTTPPrometheusClient implements PrometheusClient {
  private readonly lookbackInterval = 60 * 60 * 1000 * 12; //12 hours
  private readonly url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly errorHandler?: (error: any) => void;
  private readonly httpMethod: 'POST' | 'GET' = 'POST';
  private readonly apiPrefix: string = '/api/v1';
  // For some reason, just assigning via "= fetch" here does not end up executing fetch correctly
  // when calling it, thus the indirection via another function wrapper.
  private readonly fetchFn: FetchFn = (input: RequestInfo, init?: RequestInit): Promise<Response> => fetch(input, init);
  private requestHeaders: Headers = new Headers();

  constructor(config: PrometheusConfig) {
    this.url = config.url ? config.url : '';
    this.errorHandler = config.httpErrorHandler;
    if (config.lookbackInterval) {
      this.lookbackInterval = config.lookbackInterval;
    }
    if (config.fetchFn) {
      this.fetchFn = config.fetchFn;
    }
    if (config.httpMethod) {
      this.httpMethod = config.httpMethod;
    }
    if (config.apiPrefix) {
      this.apiPrefix = config.apiPrefix;
    }
  }

  setHeader(headerName: string, headerValue: string) {
    this.requestHeaders.set(headerName, headerValue);
  }

  labelNames(metricName?: string): Promise<string[]> {
    const end = new Date();
    const start = new Date(end.getTime() - this.lookbackInterval);

    if (metricName === undefined || metricName === '') {
      const request = this.buildRequest(
        this.labelsEndpoint(),
        new URLSearchParams({
          start: start.toISOString(),
          end: end.toISOString(),
        })
      );

      // See https://prometheus.io/docs/prometheus/latest/querying/api/#getting-label-names
      return this.fetchAPI<string[]>(request.uri, {
        method: this.httpMethod,
        body: request.body,
        headers: this.requestHeaders,
      }).catch((error) => {
        if (this.errorHandler) {
          this.errorHandler(error);
        }
        return [];
      });
    }

    return this.series(metricName).then((series) => {
      const labelNames = new Set<string>();
      for (const labelSet of series) {
        for (const [key] of Object.entries(labelSet)) {
          if (key === '__name__') {
            continue;
          }
          labelNames.add(key);
        }
      }
      return Array.from(labelNames);
    });
  }

  // labelValues return a list of the value associated to the given labelName.
  // In case a metric is provided, then the list of values is then associated to the couple <MetricName, LabelName>
  labelValues(labelName: string, metricName?: string, matchers?: Matcher[]): Promise<string[]> {
    const end = new Date();
    const start = new Date(end.getTime() - this.lookbackInterval);

    if (!metricName || metricName.length === 0) {
      const params: URLSearchParams = new URLSearchParams({
        start: start.toISOString(),
        end: end.toISOString(),
      });
      // See https://prometheus.io/docs/prometheus/latest/querying/api/#querying-label-values
      return this.fetchAPI<string[]>(`${this.labelValuesEndpoint().replace(/:name/gi, labelName)}?${params}`, {
        headers: this.requestHeaders,
      }).catch((error) => {
        if (this.errorHandler) {
          this.errorHandler(error);
        }
        return [];
      });
    }

    return this.series(metricName, matchers, labelName).then((series) => {
      const labelValues = new Set<string>();
      for (const labelSet of series) {
        for (const [key, value] of Object.entries(labelSet)) {
          if (key === '__name__') {
            continue;
          }
          if (key === labelName) {
            labelValues.add(value);
          }
        }
      }
      return Array.from(labelValues);
    });
  }

  metricMetadata(): Promise<Record<string, MetricMetadata[]>> {
    return this.fetchAPI<Record<string, MetricMetadata[]>>(this.metricMetadataEndpoint(), {
      headers: this.requestHeaders,
    }).catch((error) => {
      if (this.errorHandler) {
        this.errorHandler(error);
      }
      return {};
    });
  }

  series(metricName: string, matchers?: Matcher[], labelName?: string): Promise<Map<string, string>[]> {
    const end = new Date();
    const start = new Date(end.getTime() - this.lookbackInterval);
    const request = this.buildRequest(
      this.seriesEndpoint(),
      new URLSearchParams({
        start: start.toISOString(),
        end: end.toISOString(),
        'match[]': labelMatchersToString(metricName, matchers, labelName),
      })
    );
    // See https://prometheus.io/docs/prometheus/latest/querying/api/#finding-series-by-label-matchers
    return this.fetchAPI<Map<string, string>[]>(request.uri, {
      method: this.httpMethod,
      body: request.body,
      headers: this.requestHeaders,
    }).catch((error) => {
      if (this.errorHandler) {
        this.errorHandler(error);
      }
      return [];
    });
  }

  metricNames(): Promise<string[]> {
    return this.labelValues('__name__');
  }

  flags(): Promise<Record<string, string>> {
    return this.fetchAPI<Record<string, string>>(this.flagsEndpoint(), { headers: this.requestHeaders }).catch((error) => {
      if (this.errorHandler) {
        this.errorHandler(error);
      }
      return {};
    });
  }

  private fetchAPI<T>(resource: string, init?: RequestInit): Promise<T> {
    return this.fetchFn(this.url + resource, init)
      .then((res) => {
        if (!res.ok && ![badRequest, unprocessableEntity, serviceUnavailable].includes(res.status)) {
          throw new Error(res.statusText);
        }
        return res;
      })
      .then((res) => res.json())
      .then((apiRes: APIResponse<T>) => {
        if (apiRes.status === 'error') {
          throw new Error(apiRes.error !== undefined ? apiRes.error : 'missing "error" field in response JSON');
        }
        if (apiRes.data === undefined) {
          throw new Error('missing "data" field in response JSON');
        }
        return apiRes.data;
      });
  }

  private buildRequest(endpoint: string, params: URLSearchParams) {
    let uri = endpoint;
    let body: URLSearchParams | null = params;
    if (this.httpMethod === 'GET') {
      uri = `${uri}?${params}`;
      body = null;
    }
    return { uri, body };
  }

  private labelsEndpoint(): string {
    return `${this.apiPrefix}/labels`;
  }

  private labelValuesEndpoint(): string {
    return `${this.apiPrefix}/label/:name/values`;
  }

  private seriesEndpoint(): string {
    return `${this.apiPrefix}/series`;
  }

  private metricMetadataEndpoint(): string {
    return `${this.apiPrefix}/metadata`;
  }

  private flagsEndpoint(): string {
    return `${this.apiPrefix}/status/flags`;
  }
}

const promqlExtension = new PromQLExtension();

interface CMExpressionInputProps {
  value: string;
  onExpressionChange: (expr: string) => void;
  queryHistory: string[];
  metricNames: string[];
  executeQuery: () => void;
  loading: boolean;
  enableAutocomplete: boolean;
  enableHighlighting: boolean;
  enableLinter: boolean;
  executeExplain: () => void;
  disableExplain: boolean;
  tenant: string;
  tenantHeader: string;
}

const dynamicConfigCompartment = new Compartment();

export interface ExplainTree {
  name: string;
  children?: ExplainTree[];
}
// Autocompletion strategy that wraps the main one and enriches
// it with past query items.
export class HistoryCompleteStrategy implements CompleteStrategy {
  private complete: CompleteStrategy;
  private queryHistory: string[];
  constructor(complete: CompleteStrategy, queryHistory: string[]) {
    this.complete = complete;
    this.queryHistory = queryHistory;
  }

  promQL(context: CompletionContext): Promise<CompletionResult | null> | CompletionResult | null {
    return Promise.resolve(this.complete.promQL(context)).then((res) => {
      const { state, pos } = context;
      const tree = syntaxTree(state).resolve(pos, -1);
      const start = res != null ? res.from : tree.from;

      if (start !== 0) {
        return res;
      }

      const historyItems: CompletionResult = {
        from: start,
        to: pos,
        options: this.queryHistory.map((q) => ({
          label: q.length < 80 ? q : q.slice(0, 76).concat('...'),
          detail: 'past query',
          apply: q,
          info: q.length < 80 ? undefined : q,
        })),
        validFor: /^[a-zA-Z0-9_:]+$/,
      };

      if (res !== null) {
        historyItems.options = historyItems.options.concat(res.options);
      }
      return historyItems;
    });
  }
}

const ExpressionInput: FC<PathPrefixProps & CMExpressionInputProps> = ({
  pathPrefix,
  value,
  onExpressionChange,
  queryHistory,
  metricNames,
  executeQuery,
  loading,
  enableAutocomplete,
  enableHighlighting,
  enableLinter,
  executeExplain,
  disableExplain,
  tenant,
  tenantHeader,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const customClientTwo = new CustomHTTPPrometheusClient({
    url: pathPrefix ? pathPrefix : '',
    cache: { initialMetricList: metricNames },
  });
  const { theme } = useTheme();
  if (tenant.length > 0) {
    customClientTwo.setHeader(tenantHeader, tenant);
  }
  // (Re)initialize editor based on settings / setting changes.
  useEffect(() => {
    // Build the dynamic part of the config.
    promqlExtension
      .activateCompletion(enableAutocomplete)
      .activateLinter(enableLinter)
      .setComplete({
        remote: customClientTwo,
        completeStrategy: new HistoryCompleteStrategy(
          newCompleteStrategy({
            remote: customClientTwo,
          }),
          queryHistory
        ),
      });
    const dynamicConfig = [
      enableHighlighting ? syntaxHighlighting(promqlHighlighter) : [],
      promqlExtension.asExtension(),
      theme === 'dark' ? darkTheme : lightTheme,
    ];

    // Create or reconfigure the editor.
    const view = viewRef.current;
    if (view === null) {
      // If the editor does not exist yet, create it.
      if (!containerRef.current) {
        throw new Error('expected CodeMirror container element to exist');
      }

      const startState = EditorState.create({
        doc: value,
        extensions: [
          baseTheme,
          highlightSpecialChars(),
          history(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap]),
          placeholder('Expression (press Shift+Enter for newlines)'),
          dynamicConfigCompartment.of(dynamicConfig),
          // This keymap is added without precedence so that closing the autocomplete dropdown
          // via Escape works without blurring the editor.
          keymap.of([
            {
              key: 'Escape',
              run: (v: EditorView): boolean => {
                v.contentDOM.blur();
                return false;
              },
            },
          ]),
          Prec.highest(
            keymap.of([
              {
                key: 'Enter',
                run: (v: EditorView): boolean => {
                  executeQuery();
                  return true;
                },
              },
              {
                key: 'Shift-Enter',
                run: insertNewlineAndIndent,
              },
            ])
          ),
          EditorView.updateListener.of((update: ViewUpdate): void => {
            onExpressionChange(update.state.doc.toString());
          }),
        ],
      });

      const view = new EditorView({
        state: startState,
        parent: containerRef.current,
      });

      viewRef.current = view;

      view.focus();
    } else {
      // The editor already exists, just reconfigure the dynamically configured parts.
      view.dispatch(
        view.state.update({
          effects: dynamicConfigCompartment.reconfigure(dynamicConfig),
        })
      );
    }
    // "value" is only used in the initial render, so we don't want to
    // re-run this effect every time that "value" changes.
    //
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableAutocomplete, enableHighlighting, enableLinter, executeQuery, onExpressionChange, queryHistory, theme]);

  return (
    <>
      <InputGroup className="expression-input">
        <InputGroupAddon addonType="prepend">
          <InputGroupText>
            {loading ? <FontAwesomeIcon icon={faSpinner} spin /> : <FontAwesomeIcon icon={faSearch} />}
          </InputGroupText>
        </InputGroupAddon>
        <div ref={containerRef} className="cm-expression-input" />
        <InputGroupAddon addonType="append">
          <Button className="execute-btn" color="primary" onClick={executeQuery}>
            Execute
          </Button>
        </InputGroupAddon>
        <Button className="ml-2" color="info" onClick={executeExplain} disabled={disableExplain}>
          Explain
        </Button>
      </InputGroup>
    </>
  );
};

export default ExpressionInput;
