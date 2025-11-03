/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    experimental: {
        typedRoutes: true
    },
    images: {
        unoptimized: true, // Ensure SVGs are served as-is
        dangerouslyAllowSVG: true,
        contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    }
}

export default nextConfig


