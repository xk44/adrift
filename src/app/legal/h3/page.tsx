import type { Metadata } from "next";
import Link from "next/link";
import { H3_MODEL_NAME, REPO_ISSUES_URL } from "@/lib/tools/h3License";

export const metadata: Metadata = {
  title: "MiniMax H3 license notes - Adrift",
  description:
    "What the MiniMax H3 Community License asks of people who run Adrift's video tools, and how to report misuse.",
};

const OBLIGATIONS: { title: string; body: string }[] = [
  {
    title: "Attribution",
    body: `Any product or service built on the model must prominently display "${H3_MODEL_NAME}". Adrift shows "Powered by ${H3_MODEL_NAME}" on every H3 tool card and runner; keep it if you fork or rebrand the UI.`,
  },
  {
    title: "Safeguards for hosted services",
    body: "If you let other people generate with H3 (a public or shared deployment), you need reasonable safeguards against misuse and a way for anyone to report abuse. Adrift ships a likeness-consent check on the face and character swap tools and a Report misuse link; set NEXT_PUBLIC_ABUSE_REPORT_URL to a channel you actually monitor.",
  },
  {
    title: "No training other models on outputs",
    body: "Videos made with H3 may not be used to train, distill or improve any model that is not itself an H3 derivative.",
  },
  {
    title: "Territory",
    body: "The open-weight license excludes the European Union, the United Kingdom, South Korea and the United States (license §I.5). Using, running or distributing the weights or their outputs there is not covered by the community license; people and organizations in those regions must apply to MiniMax for a separate license first (platform.minimax.io/h3-license). Do not offer the H3 tools to users there without one.",
  },
  {
    title: "Pass the terms on",
    body: "Anyone you give access to (users of a shared server, people you send a fork to) must be bound to use restrictions at least as strict as the license's §V and its Acceptable Use Policy, and told that they apply. Distributions of the weights or modified H3 code also need a copy of the license and a NOTICE file with MiniMax's copyright line.",
  },
  {
    title: "Large commercial use",
    body: "Organizations above US$20 million in annual revenue need a separate authorization from MiniMax before commercial use.",
  },
  {
    title: "Modified weights",
    body: "LoRAs and merges stacked on H3 stay under the H3 license, whatever their own model card says, and modified files must be marked as modified.",
  },
];

export default function H3LegalPage() {
  return (
    <main className="h-full overflow-y-auto bg-light-bg text-light-primary dark:bg-dark-bg dark:text-dark-primary">
      <div className="mx-auto w-full max-w-2xl space-y-8 px-4 py-10 sm:px-6">
        <header className="space-y-2">
          <Link
            href="/tools"
            className="text-xs text-light-500 hover:text-splash dark:text-dark-400"
          >
            Back to Tools
          </Link>
          <h1 className="text-2xl font-semibold text-balance">
            {H3_MODEL_NAME}: license notes
          </h1>
          <p className="text-sm text-pretty text-light-500 dark:text-dark-400">
            Adrift's video tools (character swap, face swap, camera moves, 360
            orbit, transitions) run on {H3_MODEL_NAME} open weights under the
            MiniMax H3 Community License. This page is a plain-language summary
            for people who operate an Adrift server. It is not legal advice and
            does not replace the license text shipped with the weights; read
            that before any commercial or public use.
          </p>
        </header>

        <section aria-labelledby="operators" className="space-y-3">
          <h2
            id="operators"
            className="text-[11px] font-medium text-light-500 dark:text-dark-400"
          >
            If you run Adrift for others
          </h2>
          <ul className="space-y-3">
            {OBLIGATIONS.map((o) => (
              <li
                key={o.title}
                className="rounded-xl border border-light-100 bg-light-input p-4 dark:border-dark-750 dark:bg-dark-input"
              >
                <h3 className="text-sm font-semibold">{o.title}</h3>
                <p className="mt-1 text-sm text-light-600 dark:text-dark-600">
                  {o.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="users" className="space-y-3">
          <h2
            id="users"
            className="text-[11px] font-medium text-light-500 dark:text-dark-400"
          >
            If you use the tools
          </h2>
          <p className="text-sm text-light-600 dark:text-dark-600">
            Only upload faces and bodies you have the rights to, with consent
            from everyone shown. Do not make sexual content of real people or
            videos meant to deceive someone into thinking a real person said or
            did something.
          </p>
        </section>

        <section
          id="report"
          aria-labelledby="report-heading"
          className="space-y-3 rounded-xl border border-splash/30 bg-splash/5 p-4"
        >
          <h2 id="report-heading" className="text-sm font-semibold">
            Report misuse
          </h2>
          <p className="text-sm text-light-600 dark:text-dark-600">
            Seen a video made with these tools that uses someone without
            consent, sexualizes a real person, or is built to deceive? Open an
            issue on the project's tracker with a link or description (no need
            to attach the media itself). If a specific server operator hosted
            it, contact them too; their Report misuse link may point elsewhere.
          </p>
          <a
            href={REPO_ISSUES_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-block rounded-xl bg-splash px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Report on the issue tracker
          </a>
        </section>
      </div>
    </main>
  );
}
