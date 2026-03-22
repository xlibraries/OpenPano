import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpenPano - Video to Panorama",
  description: "Convert video to interactive panorama viewer",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.pannellum.org/2.5/pannellum.css"
        />
      </head>
      <body className="min-h-full flex flex-col">
        {children}
        <Script
          src="https://cdn.pannellum.org/2.5/pannellum.js"
          strategy="beforeInteractive"
        />
      </body>
    </html>
  );
}
