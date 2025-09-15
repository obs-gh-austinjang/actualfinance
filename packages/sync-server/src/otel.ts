import { trace, metrics } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const { ConsoleSpanExporter, BatchSpanProcessor } = tracing;

// Configuration
const serviceName = 'actual-sync-server';
const serviceVersion = process.env.npm_package_version || '25.9.0';

const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
const otlpEndpointBearerToken = process.env.OTEL_EXPORTER_OTLP_BEARER_TOKEN;

const authHeader = otlpEndpointBearerToken
  ? { Authorization: `Bearer ${otlpEndpointBearerToken}` }
  : {};

// Create resource
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
  [ATTR_SERVICE_VERSION]: serviceVersion,
});

// Create exporters
const otlpTraceExporter = new OTLPTraceExporter({
  url: `${otlpEndpoint}/v1/traces`,
  headers: {
    ...authHeader,
    'x-observe-target-package': 'Tracing',
  },
});

const consoleTraceExporter = new ConsoleSpanExporter();

const otlpMetricExporter = new OTLPMetricExporter({
  url: `${otlpEndpoint}/v1/metrics`,
  headers: {
    ...authHeader,
    'x-observe-target-package': 'Metrics',
  },
});

const consoleMetricExporter = new ConsoleMetricExporter();

// Initialize OpenTelemetry SDK with multiple exporters
export const sdk = new NodeSDK({
  resource,
  spanProcessors: [
    new BatchSpanProcessor(otlpTraceExporter),
    new BatchSpanProcessor(consoleTraceExporter),
  ],
  metricReader: new PeriodicExportingMetricReader({
    exporter: otlpMetricExporter,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

// Additional console metric reader for real-time terminal output
export const consoleMetricReader = new PeriodicExportingMetricReader({
  exporter: consoleMetricExporter,
  exportIntervalMillis: 5000, // Export every 5 seconds for real-time visibility
});

// Initialize Logger Provider
const loggerProvider = new LoggerProvider({
  resource,
  processors: [
    new BatchLogRecordProcessor(
      new OTLPLogExporter({
        url: `${otlpEndpoint}/v1/logs`,
        headers: {
          ...authHeader,
          'x-observe-target-package': 'Logs',
        },
      }),
    ),
  ],
});

// Export logger, tracer, and meter for use in application
export const logger = logs.getLogger(serviceName);

// Get tracer and meter from the global providers after SDK initialization
export const tracer = trace.getTracer(serviceName, serviceVersion);
export const meter = metrics.getMeter(serviceName, serviceVersion);

// Export common metrics for use across the application
export const syncOperationsTotal = meter.createCounter(
  'sync_operations_total',
  {
    description: 'Total number of sync operations',
  },
);

export const fileOperationsTotal = meter.createCounter(
  'file_operations_total',
  {
    description: 'Total number of file operations',
  },
);

export const errorRateTotal = meter.createCounter('errors_total', {
  description: 'Total number of errors by type',
});

export const authOperationsTotal = meter.createCounter('auth_operations_total', {
  description: 'Total number of authentication operations',
});

export const adminOperationsTotal = meter.createCounter('admin_operations_total', {
  description: 'Total number of admin operations',
});

export const secretOperationsTotal = meter.createCounter('secret_operations_total', {
  description: 'Total number of secret operations',
});

export const bankIntegrationOperationsTotal = meter.createCounter('bank_integration_operations_total', {
  description: 'Total number of bank integration operations',
});

// Initialize OpenTelemetry and return initialized components
export function initOtel() {
  try {
    logs.setGlobalLoggerProvider(loggerProvider);
    sdk.start();

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'OpenTelemetry SDK started for Actual Budget sync server with console exporters',
      attributes: {
        service: serviceName,
        version: serviceVersion,
      },
    });

    console.log(
      'OpenTelemetry initialized successfully with console exporters for real-time output',
    );
    console.log('- Traces: Exported to both OTLP and console');
    console.log(
      '- Metrics: Exported to OTLP (console metrics require separate meter provider setup)',
    );
    console.log('- Logs: Exported to OTLP');
  } catch (error) {
    console.error('Error starting OpenTelemetry SDK:', error);
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error starting OpenTelemetry SDK',
      attributes: { error: (error as Error).message },
    });
    throw error;
  }
}

// Utility function to log with OpenTelemetry trace context
export function logWithTraceContext(
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: unknown,
) {
  const activeSpan = trace.getActiveSpan();
  const spanContext = activeSpan?.spanContext();

  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...(data && { data }),
    ...(spanContext && {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
    }),
  };

  console.log(JSON.stringify(logEntry, null, 2));

  // Also emit to OpenTelemetry logger
  const severityMap = {
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
  };

  logger.emit({
    severityNumber: severityMap[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes: {
      ...(data && { data: JSON.stringify(data) }),
      ...(spanContext && {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      }),
    },
  });
}

// Graceful shutdown
export function shutdownOtel(): void {
  try {
    sdk.shutdown();
    consoleMetricReader.shutdown();
    console.log('OpenTelemetry SDK shutdown successfully');
  } catch (error) {
    console.error('Error shutting down OpenTelemetry SDK:', error);
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error shutting down OpenTelemetry SDK',
      attributes: { error: (error as Error).message },
    });
    throw error;
  }
}
