const port = process.env.OPENCLAW_HOST_PORT || "18789";
const configuredUrl = process.env.OPENCLAW_HEALTH_URL || `http://127.0.0.1:${port}/healthz`;

function validatedHealthUrl(value) {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid health URL");
    }
    return url;
  } catch {
    throw new Error("HEALTHCHECK_CONFIG_INVALID");
  }
}

try {
  const url = validatedHealthUrl(configuredUrl);
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("HEALTHCHECK_HTTP_FAILED");
  console.log(JSON.stringify({ component: "gateway", eventType: "HEALTHCHECK", outcome: "SUCCEEDED" }));
} catch (error) {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
    ? error.message
    : "HEALTHCHECK_FAILED";
  console.error(JSON.stringify({ component: "gateway", eventType: "HEALTHCHECK", outcome: "FAILED", code }));
  process.exitCode = 1;
}
