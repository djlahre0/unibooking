import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "unibooking — Interactive API Explorer",
  description:
    "Interactive Try-It explorer for the unibooking package: stateless, unified CRUD across 16 booking & calendar providers including Google, Outlook, Square, and Acuity.",
  keywords: [
    "unibooking",
    "calendar api",
    "booking api",
    "unified api",
    "scheduling",
    "google calendar",
    "outlook calendar",
    "square booking"
  ],
  authors: [{ name: "djlahre0" }],
  openGraph: {
    title: "unibooking — Interactive API Explorer",
    description: "Stateless, unified CRUD for 16 booking & calendar providers.",
    siteName: "unibooking",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "unibooking — Interactive API Explorer",
    description: "Stateless, unified CRUD for 16 booking & calendar providers.",
  },
  robots: {
    index: true,
    follow: true,
  }
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Applies the saved theme BEFORE first paint. Without this, a visitor
            who chose Light while their OS is dark sees a dark flash on every
            load, because React only reaches ThemeToggle after hydration.
            Inlined and synchronous by necessity; wrapped in try/catch because
            reading localStorage throws outright when site data is blocked, and
            a colour preference is never worth breaking the page over. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var s=localStorage.getItem('unibooking:demo:ui:v1');if(s){var t=JSON.parse(s).theme;if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}}catch(e){}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
