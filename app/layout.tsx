import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import { getTrustedAppOrigin } from "../lib/http";
import "./globals.css";
import AuthProvider from "./AuthProvider";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const origin = getTrustedAppOrigin(requestHeaders);
  const title = "Satmi Support";
  const description = "Private Gmail, Instagram & Facebook customer support workspace for Satmi.";
  const image = `${origin}/og.png`;
  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title,
      description,
      images: [
        {
          url: image,
          width: 1733,
          height: 907,
          alt: "Satmi Support — Customer Support Workspace",
        },
      ],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <head>
        <script
          id="satmi-theme-init"
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('satmi-theme')||localStorage.getItem('theme');var d=s==='dark'||s==='midnight'||(!s&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';r.dataset.theme=d?'dark':'light';}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased selection:bg-accent selection:text-accent-foreground">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
