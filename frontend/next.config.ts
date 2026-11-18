import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const API = process.env.API_ORIGIN || "http://localhost:8000";

/**
 * Production: static export (`out/`) served by FastAPI from the same origin, so a single
 * Railway service runs everything and the session cookie just works.
 * Development: `next dev` proxies /api and /media to the FastAPI server.
 */
const nextConfig: NextConfig = {
  output: isProd ? "export" : undefined,
  trailingSlash: isProd, // export writes folder/index.html; FastAPI serves those
  images: { unoptimized: true },
  ...(isProd
    ? {}
    : {
        async rewrites() {
          return [
            { source: "/api/:path*", destination: `${API}/api/:path*` },
            { source: "/media/:path*", destination: `${API}/media/:path*` },
          ];
        },
      }),
};

export default nextConfig;
