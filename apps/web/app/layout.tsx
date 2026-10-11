import type { Metadata, Viewport } from "next";
import { Nunito } from "next/font/google";
import "./globals.css";

// Round, soft letters to go with the soft colours. One family for everything, an AI speaking included.
const hanken = Nunito({ subsets: ["latin"], variable: "--font-hanken", display: "swap" });

export const metadata: Metadata = {
  title: "Longtable",
  description: "One room where a small software team, their AIs and their client work together.",
};

const THEME = `try{document.documentElement.dataset.theme=localStorage.getItem("lt-theme")==="dark"?"dark":"light"}catch(e){}`;

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${hanken.variable}`} suppressHydrationWarning>
      <head>
        {/* The chosen theme goes on before the first paint, so a dark page never flashes light. */}
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
