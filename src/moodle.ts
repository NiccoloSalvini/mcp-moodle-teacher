/**
 * Thin Moodle web-service client.
 *
 * One transport for every tool: a POST to /webservice/rest/server.php carrying
 * the token, the function name, and Moodle's peculiar array parameter encoding.
 */

export class MoodleError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly fn: string,
  ) {
    super(`Moodle error [${code}] in ${fn}: ${detail}`);
    this.name = "MoodleError";
  }
}

/** Moodle wants nested structures as name[0][key]=value, not JSON. */
function flatten(prefix: string, value: unknown, out: URLSearchParams): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => flatten(`${prefix}[${i}]`, item, out));
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(`${prefix}[${k}]`, v, out);
    }
  } else if (typeof value === "boolean") {
    out.set(prefix, value ? "1" : "0");
  } else {
    out.set(prefix, String(value));
  }
}

export class Moodle {
  private readonly url: string;
  private readonly token: string;

  constructor(url = process.env.MOODLE_URL, token = process.env.MOODLE_TOKEN) {
    this.url = (url ?? "").trim();
    this.token = (token ?? "").trim();
    if (!this.url || !this.token) {
      throw new Error(
        "MOODLE_URL and MOODLE_TOKEN are not set. MOODLE_URL is your site plus " +
          "/webservice/rest/server.php; the token comes from Preferences > Security keys, " +
          "or from scripts/get-moodle-token.sh. See the README.",
      );
    }
  }

  /** Never let the token reach a log line or an error message. */
  private redact(text: string): string {
    return this.token ? text.split(this.token).join("<token>") : text;
  }

  async call<T = any>(fn: string, params: Record<string, unknown> = {}): Promise<T> {
    // The token goes in the POST body, never in the query string: a URL is
    // written to proxy logs, to the server's access log and to any client's
    // request log, and a Moodle token is a bearer credential with all the
    // caller's rights.
    const body = new URLSearchParams();
    body.set("wstoken", this.token);
    body.set("wsfunction", fn);
    body.set("moodlewsrestformat", "json");
    for (const [key, value] of Object.entries(params)) flatten(key, value, body);

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new MoodleError("transport", this.redact(String(error)), fn);
    }

    if (!response.ok) {
      throw new MoodleError("http", `HTTP ${response.status}`, fn);
    }

    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      // A login page or an HTML error means the URL is not the web-service endpoint.
      throw new MoodleError(
        "not_json",
        "The response was not JSON. Check MOODLE_URL ends in /webservice/rest/server.php " +
          "and that it is the exact host Moodle knows itself by (with or without www).",
        fn,
      );
    }

    if (data && typeof data === "object" && ("errorcode" in data || data.exception)) {
      throw new MoodleError(
        data.errorcode ?? "exception",
        this.redact(data.message ?? "unknown error"),
        fn,
      );
    }
    return data as T;
  }
}

/** Moodle speaks Unix timestamps; 0 means "not set", which is not 1970. */
export function when(timestamp?: number): string | null {
  if (!timestamp) return null;
  return new Date(timestamp * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** Moodle stores descriptions as HTML. Tools return text a human can read. */
export function plain(html?: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
