import type { Plugin } from "vite";

const brandName = "Shanaya";

const pages = {
  home: {
    title: "Shanaya AI Companion | 3D Avatar, Voice Chat & Local AI",
    description: "Meet Shanaya, a multilingual AI companion with an expressive 3D avatar, voice chat, cloud AI, WebLLM, and optional on-device inference for web, mobile, and desktop.",
  },
  about: {
    title: "About Shanaya | Private AI Companion with Voice & 3D Avatar",
    description: "Learn how Shanaya combines an animated 3D AI avatar, multilingual voice conversation, cloud and local AI, offline-capable inference, and confirmation-gated device actions.",
  },
} as const;

type SeoOptions = { mode: string };

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function resolveSiteOrigin(raw: string) {
  if (!raw.trim()) return "";
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("VITE_SITE_URL must use HTTPS outside local development.");
  }
  return url.origin;
}

function structuredData(siteOrigin: string, pagePath: string, page: (typeof pages)[keyof typeof pages]) {
  const canonical = new URL(pagePath, siteOrigin).toString();
  const appUrl = new URL("/", siteOrigin).toString();
  const imageUrl = new URL("/social-card.svg", siteOrigin).toString();
  const repositoryUrl = "https://github.com/HarshTambade/Shanaya---Your-AI-companion-";
  const faq = [
    {
      "@type": "Question",
      name: "Does Shanaya work offline?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Shanaya supports optional offline inference with WebLLM in compatible browsers and downloaded GGUF models in supported mobile apps. Initial model downloads require internet access.",
      },
    },
    {
      "@type": "Question",
      name: "Can I talk to Shanaya by voice?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. Shanaya provides multilingual voice input and speech playback where browser or device speech capabilities are available, including English, Hindi, and Marathi options.",
      },
    },
    {
      "@type": "Question",
      name: "Which platforms support Shanaya?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Shanaya supports the web and PWA, with Capacitor-based Android and iOS builds and an Electron desktop shell for macOS, Windows, and Linux.",
      },
    },
  ];
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${appUrl}#organization`,
        name: brandName,
        url: appUrl,
        sameAs: [repositoryUrl],
        logo: imageUrl,
      },
      {
        "@type": "WebSite",
        "@id": `${appUrl}#website`,
        url: appUrl,
        name: brandName,
        inLanguage: "en",
        publisher: { "@id": `${appUrl}#organization` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${appUrl}#application`,
        name: brandName,
        url: appUrl,
        applicationCategory: "CommunicationApplication",
        applicationSubCategory: "AI companion",
        operatingSystem: "Web, Android, iOS, macOS, Windows, Linux",
        description: pages.home.description,
        image: imageUrl,
        browserRequirements: "Requires a modern browser with JavaScript enabled",
        softwareHelp: { "@type": "CreativeWork", url: `${appUrl}about/` },
        publisher: { "@id": `${appUrl}#organization` },
        featureList: [
          "Responsive 3D avatar with emotion-aware expressions",
          "English, Hindi, and Marathi voice interaction",
          "Groq cloud inference with optional local AI modes",
          "Confirmation prompts for supported sensitive device actions",
        ],
      },
      {
        "@type": "WebPage",
        "@id": `${canonical}#webpage`,
        url: canonical,
        name: page.title,
        description: page.description,
        isPartOf: { "@id": `${appUrl}#website` },
        about: { "@id": `${appUrl}#application` },
        inLanguage: "en",
      },
      ...(pagePath === "/" ? [{
        "@type": "FAQPage",
        "@id": `${canonical}#faq`,
        mainEntity: faq,
      }] : []),
    ],
  };
  return JSON.stringify(graph).replaceAll("<", "\\u003c");
}

export function shanayaSeoPlugin({ mode }: SeoOptions): Plugin {
  const explicitSiteUrl = process.env.VITE_SITE_URL?.trim() ?? "";
  const vercelProductionDomain = process.env.VERCEL_ENV === "production"
    ? process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ?? ""
    : "";
  const siteOrigin = resolveSiteOrigin(explicitSiteUrl || vercelProductionDomain);
  const isProductionDeployment = process.env.VERCEL_ENV
    ? process.env.VERCEL_ENV === "production"
    : mode === "production";
  const indexable = isProductionDeployment && Boolean(siteOrigin);

  return {
    name: "shanaya-seo",
    transformIndexHtml(html, context) {
      const pagePath = context.path.includes("/about/") ? "/about/" : "/";
      const page = pagePath === "/about/" ? pages.about : pages.home;
      const image = siteOrigin ? new URL("/social-card.svg", siteOrigin).toString() : "/social-card.svg";
      const canonical = indexable ? new URL(pagePath, siteOrigin).toString() : "";
      const tags = [
        `<meta name="robots" content="${indexable ? "index,follow,max-image-preview:large" : "noindex,nofollow"}" />`,
        `<meta name="author" content="Shanaya" />`,
        `<meta name="publisher" content="Shanaya" />`,
        `<meta name="keywords" content="AI companion, AI chatbot, 3D AI avatar, voice AI companion, multilingual AI, offline AI, local AI, WebLLM, private AI assistant" />`,
        `<meta name="referrer" content="strict-origin-when-cross-origin" />`,
        `<meta name="color-scheme" content="dark" />`,
        canonical ? `<link rel="canonical" href="${escapeAttribute(canonical)}" />` : "",
        `<link rel="alternate" hreflang="en" href="${escapeAttribute(canonical || pagePath)}" />`,
        `<link rel="author" href="https://github.com/HarshTambade" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="${brandName}" />`,
        `<meta property="og:title" content="${escapeAttribute(page.title)}" />`,
        `<meta property="og:description" content="${escapeAttribute(page.description)}" />`,
        canonical ? `<meta property="og:url" content="${escapeAttribute(canonical)}" />` : "",
        `<meta property="og:image" content="${escapeAttribute(image)}" />`,
        `<meta property="og:image:width" content="1200" />`,
        `<meta property="og:image:height" content="630" />`,
        `<meta property="og:image:alt" content="Shanaya, a multilingual AI companion with a living 3D avatar" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${escapeAttribute(page.title)}" />`,
        `<meta name="twitter:description" content="${escapeAttribute(page.description)}" />`,
        `<meta name="twitter:image" content="${escapeAttribute(image)}" />`,
        indexable ? `<script type="application/ld+json">${structuredData(siteOrigin, pagePath, page)}</script>` : "",
      ].filter(Boolean).join("\n    ");

      return html
        .replace("__SHANAYA_PAGE_TITLE__", escapeAttribute(page.title))
        .replace("__SHANAYA_PAGE_DESCRIPTION__", escapeAttribute(page.description))
        .replace("<!-- SHANAYA_SEO_TAGS -->", tags);
    },
    generateBundle() {
      const robots = [
        "User-agent: *",
        "Allow: /",
        "Disallow: /api/",
        "Disallow: /mcp",
        ...(indexable ? [`Sitemap: ${new URL("/sitemap.xml", siteOrigin).toString()}`] : []),
        "",
      ].join("\n");
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots });

      if (indexable) {
        const today = new Date().toISOString().slice(0, 10);
        const sitemapUrls = ["/", "/about/"].map((path) => (
          `  <url><loc>${new URL(path, siteOrigin).toString()}</loc><lastmod>${today}</lastmod><changefreq>${path === "/" ? "weekly" : "monthly"}</changefreq><priority>${path === "/" ? "1.0" : "0.7"}</priority></url>`
        )).join("\n");
        this.emitFile({
          type: "asset",
          fileName: "sitemap.xml",
          source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls}\n</urlset>\n`,
        });
      }
    },
  };
}
