import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "unibooking — Try It",
  description:
    "Interactive Try-It explorer for the unibooking package: stateless, unified CRUD across 16 booking & calendar providers.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
