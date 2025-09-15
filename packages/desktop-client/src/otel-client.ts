import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  SimpleSpanProcessor,
  WebTracerProvider,
} from '@opentelemetry/sdk-trace-web';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

// Configuration
const serviceName = 'actual-budget-client';
const serviceVersion = process.env.npm_package_version || '25.9.0';

// Environment variables for client-side configuration
// In Vite, use import.meta.env instead of process.env for client-side variables
const otlpEndpoint =
  (typeof window !== 'undefined' &&
    (window as unknown as { __OTEL_ENDPOINT__?: string }).__OTEL_ENDPOINT__) ||
  import.meta.env?.VITE_OTEL_EXPORTER_OTLP_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  'http://localhost:4318';

const otlpEndpointBearerToken =
  (typeof window !== 'undefined' &&
    (window as unknown as { __OTEL_BEARER_TOKEN__?: string })
      .__OTEL_BEARER_TOKEN__) ||
  import.meta.env?.VITE_OTEL_EXPORTER_OTLP_BEARER_TOKEN ||
  process.env.OTEL_EXPORTER_OTLP_BEARER_TOKEN;

const authHeader = otlpEndpointBearerToken
  ? { Authorization: `Bearer ${otlpEndpointBearerToken}` }
  : {};

// Create resource
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
  [ATTR_SERVICE_VERSION]: serviceVersion,
});

// Create tracer provider
const provider = new WebTracerProvider({
  resource,
  spanProcessors: [
    new SimpleSpanProcessor(
      new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
        headers: {
          ...authHeader,
          'x-observe-target-package': 'Tracing',
        },
      }),
    ),
  ],
});

// Export logger for use in application
export const logger = logs.getLogger(serviceName);

// Initialize OpenTelemetry and return initialized components
export function initOtel() {
  try {
    // Register instrumentations
    registerInstrumentations({
      instrumentations: [
        new FetchInstrumentation({
          // Ignore OTLP endpoint to prevent infinite loops and internal API calls
          ignoreUrls: [
            new RegExp(`.*${otlpEndpoint}.*`),
            /.*\/api\/internal\/.*/,
          ],
        }),
      ],
    });

    // Register the tracer provider
    provider.register({});

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'OpenTelemetry Web SDK started for Actual Budget client',
      attributes: {
        service: serviceName,
        version: serviceVersion,
        endpoint: otlpEndpoint,
      },
    });

    console.log(
      'OpenTelemetry initialized successfully for Actual Budget client',
    );
    console.log(`- Service: ${serviceName}`);
    console.log(`- Version: ${serviceVersion}`);
    console.log(`- OTLP Endpoint: ${otlpEndpoint}`);
    console.log('- Traces: Exported to OTLP');
    console.log('- Fetch instrumentation: Enabled');

    return true;
  } catch (error) {
    console.error('Error starting OpenTelemetry SDK:', error);
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error starting OpenTelemetry SDK',
      attributes: { error: (error as Error).message },
    });
    return false;
  }
}

// Utility function to log with OpenTelemetry
export function logWithContext(
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: unknown,
) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    service: serviceName,
    ...(data && { data }),
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
      service: serviceName,
      ...(data && { data: JSON.stringify(data) }),
    },
  });
}
