/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // ESLint runs locally + in CI; don't fail the production build over
  // stylistic rules like `react/no-unescaped-entities`. TypeScript
  // compile (which catches real bugs) still runs.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
