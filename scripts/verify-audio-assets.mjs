// Read-only production check. Does not download the 32 MB core or access secrets.
const origin = "https://proftopdf.velodent.eu";
for (const asset of [
  "index.js",
  "worker.js",
  "core/ffmpeg-core.js",
  "core/ffmpeg-core.wasm",
]) {
  try {
    const response = await fetch(
      `${origin}/ffmpeg/v0.12.15-core0.12.10/${asset}`,
      {
        method: "HEAD",
        signal: AbortSignal.timeout(15_000),
      },
    );
    console.log(
      JSON.stringify({
        asset,
        status: response.status,
        mime: response.headers.get("content-type"),
        bytes: response.headers.get("content-length"),
        cache: response.headers.get("cache-control"),
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({ asset, error: error.message, cause: error.cause?.code }),
    );
    process.exitCode = 1;
  }
}
