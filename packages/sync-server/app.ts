// Initialize OpenTelemetry FIRST before any other imports
import { run as runMigrations } from './src/migrations.js';
import { initOtel, shutdownOtel } from './src/otel.js';

// Initialize OpenTelemetry
initOtel();

runMigrations()
  .then(() => {
    //import the app here becasue initial migrations need to be run first - they are dependencies of the app.js
    import('./src/app.js').then(app => app.run()); // run the app
  })
  .catch(err => {
    console.log('Error starting app:', err);
    process.exit(1);
  });

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  shutdownOtel();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  shutdownOtel();
  process.exit(0);
});
