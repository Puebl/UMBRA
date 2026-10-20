// Set production defaults before the server module constructs the application.
process.env.NODE_ENV ??= 'production';
await import('../server/index.ts');
