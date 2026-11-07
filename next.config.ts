import type { NextConfig } from "next";

// Logos, photos and brand marks in public/ keep their file names between deploys, so browsers
// keep them for a day and then revalidate in the background. The CDN keeps them for a year;
// every Vercel deploy clears the CDN cache, so a changed file still goes out on the next deploy.
// Built JS, CSS and fonts already get hashed names and immutable caching from Next.
const staticAsset = "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return ["brands", "connectors", "integrations", "logos", "people"].map((dir) => ({
      source: `/${dir}/:path*`,
      headers: [{ key: "Cache-Control", value: staticAsset }],
    }));
  },
};

export default nextConfig;
