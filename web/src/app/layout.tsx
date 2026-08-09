import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  // Text stays readable in the fallback face while the webfont loads. On a school phone
  // over a slow connection, `swap` is the difference between reading the crisis numbers
  // immediately and staring at blank space until a font arrives.
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lighthouse",
  description: "Anonymous listening and triage for school students. Synthetic demo data.",
  robots: {
    // Nothing here should be indexed. The student side is a disclosure surface and the
    // console is a safeguarding queue; neither belongs in a search result, and the demo
    // being public is not the same as it being crawlable.
    index: false,
    follow: false,
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* First in the tab order, invisible until focused. See `.skip-link` in
            globals.css — every console screen puts an identity bar and navigation ahead
            of the content. */}
        <a href="#content" className="skip-link">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
