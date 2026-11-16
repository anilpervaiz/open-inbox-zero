import "./globals.css";
import type { ReactNode } from 'react';

export const metadata = { title: 'Open Inbox Zero', description: 'An open-source email assistant.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="text-scale" content="scale" />
      </head>
      <body>{children}</body>
    </html>
  );
}
