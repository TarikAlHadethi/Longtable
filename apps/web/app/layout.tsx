import type { Metadata, Viewport } from "next";
import { Figtree, Fraunces } from "next/font/google";
import "./globals.css";

// Round, quiet letters to go with the soft colours: Figtree for the product, Fraunces at its softest for an AI speaking.
const hanken = Figtree({ subsets: ["latin"], variable: "--font-hanken", display: "swap" });
const newsreader = Fraunces({ subsets: ["latin"], variable: "--font-newsreader", display: "swap", axes: ["SOFT", "opsz"] });

export const metadata: Metadata = {
  title: "Longtable",
  description: "One room where a small software team, their AIs and their client work together.",
};

const THEME = `try{document.documentElement.dataset.theme=localStorage.getItem("lt-theme")==="dark"?"dark":"light"}catch(e){}`;

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${hanken.variable} ${newsreader.variable}`} suppressHydrationWarning>
      <head>
        {/* The chosen theme goes on before the first paint, so a dark page never flashes light. */}
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
