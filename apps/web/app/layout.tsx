import type { Metadata, Viewport } from "next";
import { DM_Sans, Source_Serif_4 } from "next/font/google";
import "./globals.css";
import { Visits } from "@/components/visits";
import { UpdateNotice } from "@/components/update-notice";

// Sturdy, warm letters: a plain sans for the product and a calm book serif for an AI speaking.
const hanken = DM_Sans({ subsets: ["latin"], variable: "--font-hanken", display: "swap" });
const voice = Source_Serif_4({ subsets: ["latin"], variable: "--font-voice-face", display: "swap" });

export const metadata: Metadata = {
  title: "Longtable",
  description: "One room where a small software team, their AIs and their client work together.",
};

const THEME = `try{document.documentElement.dataset.theme=localStorage.getItem("lt-theme")==="dark"?"dark":"light"}catch(e){}`;

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${hanken.variable} ${voice.variable}`} suppressHydrationWarning>
      <head>
        {/* The chosen theme goes on before the first paint, so a dark page never flashes light. */}
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      <body>{children}<UpdateNotice /><Visits /></body>
    </html>
  );
}
