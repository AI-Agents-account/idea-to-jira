const port = process.env.OPENCLAW_HOST_PORT || "18789";
const url = process.env.OPENCLAW_HEALTH_URL || `http://127.0.0.1:${port}/healthz`;

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  console.log(`healthy: ${url}`);
} catch (error) {
  console.error(`unhealthy: ${url}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
