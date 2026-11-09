import type { ReactNode } from 'react';

export const metadata = {
  title: 'Incident Investigator',
  description: 'Multi-agent production incident investigation system',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: '#0d1117',
          color: '#e6edf3',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        {children}
      </body>
    </html>
  );
}
