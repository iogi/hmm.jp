const FEEDS = [
  {
    source: "Hatena Blog",
    url: "https://iogi.hatenablog.com/rss",
    hosts: ["iogi.hatenablog.com"]
  },
  {
    source: "Zenn",
    url: "https://zenn.dev/iogi/feed",
    hosts: ["zenn.dev"]
  },
  {
    source: "Qiita",
    url: "https://qiita.com/iogi/feed",
    hosts: ["qiita.com"]
  }
];

const CACHE_SECONDS = 6 * 60 * 60;
const MAX_ITEMS = 5;

export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/feeds", context.request.url), {
    method: "GET"
  });
  const cached = await cache.match(cacheKey);

  if (cached) return cached;

  try {
    const feedResults = await Promise.allSettled(FEEDS.map(loadFeed));
    const items = feedResults
      .flatMap((result) => result.status === "fulfilled" ? result.value : [])
      .filter((item) => Number.isFinite(Date.parse(item.date)))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, MAX_ITEMS);

    if (items.length === 0) {
      return json({ error: "No feed items are currently available." }, 502, 300);
    }

    const enrichedItems = await Promise.all(items.map(addOpenGraphData));
    const response = json(
      {
        items: enrichedItems,
        updatedAt: new Date().toISOString()
      },
      200,
      CACHE_SECONDS
    );

    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    console.error("Failed to build feeds response:", error);
    return json({ error: "Could not load feeds." }, 502, 300);
  }
}

async function loadFeed(feed) {
  const response = await fetch(feed.url, {
    headers: {
      accept: "application/atom+xml, application/rss+xml, application/xml, text/xml"
    },
    cf: {
      cacheEverything: true,
      cacheTtl: 60 * 60
    }
  });

  if (!response.ok) {
    throw new Error(`${feed.source} returned HTTP ${response.status}`);
  }

  const xml = await response.text();
  const blocks = extractBlocks(xml, "item", 10);
  const entries = blocks.length > 0 ? blocks : extractBlocks(xml, "entry", 10);

  return entries
    .map((entry) => parseEntry(entry, feed))
    .filter((item) => item.title && item.url && item.date);
}

function extractBlocks(xml, tag, limit) {
  const blocks = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "gi");
  let match;

  while ((match = pattern.exec(xml)) && blocks.length < limit) {
    blocks.push(match[0]);
  }

  return blocks;
}

function parseEntry(entry, feed) {
  const rawLink = readTag(entry, ["link"]);
  const atomLink = readAtomLink(entry);
  const url = safeArticleUrl(atomLink || rawLink, feed.hosts);
  const content = decodeEntities(readTag(entry, ["description", "summary", "content"]));

  return {
    source: feed.source,
    title: cleanText(readTag(entry, ["title"])),
    url,
    date: cleanText(readTag(entry, ["pubDate", "published", "updated"])),
    feedImage: readFirstImage(content)
  };
}

function readTag(xml, names) {
  for (const name of names) {
    const pattern = new RegExp(
      `<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`,
      "i"
    );
    const match = xml.match(pattern);
    if (match) return unwrapCdata(match[1]).trim();
  }

  return "";
}

function readAtomLink(entry) {
  const tags = entry.match(/<link\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const attributes = readAttributes(tag);
    if (attributes.href && (!attributes.rel || attributes.rel === "alternate")) {
      return decodeEntities(attributes.href);
    }
  }

  return "";
}

async function addOpenGraphData(item) {
  try {
    const response = await fetch(item.url, {
      headers: {
        accept: "text/html"
      },
      cf: {
        cacheEverything: true,
        cacheTtl: 24 * 60 * 60
      }
    });

    if (!response.ok) return withoutInternalFields(item);

    const head = await readDocumentHead(response);
    const metadata = readMetadata(head);

    return {
      ...withoutInternalFields(item),
      image: safeImageUrl(metadata["og:image"] || metadata["twitter:image"] || item.feedImage),
      description: cleanText(metadata["og:description"] || metadata.description).slice(0, 240)
    };
  } catch (error) {
    console.error(`Failed to load OGP for ${item.url}:`, error);
    return {
      ...withoutInternalFields(item),
      image: safeImageUrl(item.feedImage),
      description: ""
    };
  }
}

async function readDocumentHead(response) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";

  while (html.length < 128 * 1024) {
    const { done, value } = await reader.read();
    if (done) break;

    html += decoder.decode(value, { stream: true });
    const end = html.search(/<\/head\s*>/i);

    if (end !== -1) {
      await reader.cancel();
      return html.slice(0, end);
    }
  }

  await reader.cancel();
  return html;
}

function readMetadata(html) {
  const metadata = {};
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const attributes = readAttributes(tag);
    const key = (attributes.property || attributes.name || "").toLowerCase();
    if (key && attributes.content) metadata[key] = decodeEntities(attributes.content);
  }

  return metadata;
}

function readAttributes(tag) {
  const attributes = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;

  while ((match = pattern.exec(tag))) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }

  return attributes;
}

function readFirstImage(html) {
  const tag = html.match(/<img\b[^>]*>/i);
  if (!tag) return "";
  return readAttributes(tag[0]).src || "";
}

function safeArticleUrl(value, allowedHosts) {
  try {
    const url = new URL(decodeEntities(value).trim());
    return url.protocol === "https:" && allowedHosts.includes(url.hostname) ? url.href : "";
  } catch {
    return "";
  }
}

function safeImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function cleanText(value) {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapCdata(value) {
  return value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");
}

function decodeEntities(value = "") {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: "\""
  };

  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (entity, code) => {
    if (code[0] !== "#") return named[code.toLowerCase()] || entity;
    const radix = code[1].toLowerCase() === "x" ? 16 : 10;
    const number = parseInt(code.slice(radix === 16 ? 2 : 1), radix);
    return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
  });
}

function withoutInternalFields({ feedImage, ...item }) {
  return item;
}

function json(body, status, maxAge) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${Math.min(maxAge, 3600)}, s-maxage=${maxAge}`,
      "x-content-type-options": "nosniff"
    }
  });
}
