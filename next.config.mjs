/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // ESLint runs locally + in CI; don't fail the production build over
  // stylistic rules like `react/no-unescaped-entities`. TypeScript
  // compile (which catches real bugs) still runs.
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // lib/bo-withdrawal-pdf.ts reads the CDBL Form 14 templates from public/
    // with fs at request time. Pin them into the one route that renders the
    // form so the serverless bundle can never ship without them.
    outputFileTracingIncludes: {
      "/api/agent/sell/bo-form": ["./public/forms/cdbl/*.pdf"],
    },
  },
};

export default nextConfig;
