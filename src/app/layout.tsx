import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "./peeblo.css";

// Type: Baloo 2 headings, Quicksand body, JetBrains Mono labels, Lato for the Slack mocks.
// Bundled locally (src/fonts) so builds never depend on reaching Google Fonts.
const display = localFont({ src: "../fonts/baloo-2-latin-wght-normal.woff2", variable: "--font-display", weight: "400 800", display: "swap" });
const body = localFont({ src: "../fonts/quicksand-latin-wght-normal.woff2", variable: "--font-body", weight: "300 700", display: "swap" });
const mono = localFont({ src: "../fonts/jetbrains-mono-latin-wght-normal.woff2", variable: "--font-receipt", weight: "100 800", display: "swap" });
// Slack's own UI face, used only inside the Slack mocks so they read as real Slack.
const slack = localFont({
  src: [
    { path: "../fonts/lato-latin-400-normal.woff2", weight: "400" },
    { path: "../fonts/lato-latin-700-normal.woff2", weight: "700" },
    { path: "../fonts/lato-latin-900-normal.woff2", weight: "900" },
  ],
  variable: "--font-slack",
  display: "swap",
});

const description =
  "Peeblo is an open-source home for your team's AI teammates in Slack. Make one for any task, self-host it on your servers, and keep your data, keys and AI budget under your control.";

export const metadata: Metadata = {
  metadataBase: new URL("https://peeblo.xyz"),
  title: "Peeblo · Your open-source AI teammates",
  description,
  openGraph: { type: "website", url: "/", siteName: "Peeblo", title: "Peeblo · Your open-source AI teammates", description },
  twitter: { card: "summary_large_image", title: "Peeblo · Your open-source AI teammates", description },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable} ${slack.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
