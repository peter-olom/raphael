import { defineConfig } from 'vitepress';

const githubRepo = process.env.GITHUB_REPOSITORY ?? 'ptr/raphael';
const maintainer = 'Peter Olom';

export default defineConfig({
  title: 'Raphael',
  description: 'Local trace and wide event viewer for debugging distributed systems.',
  lang: 'en-US',
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico', sizes: 'any' }],
    ['link', { rel: 'icon', type: 'image/png', href: '/favicon-32x32.png', sizes: '32x32' }],
    ['link', { rel: 'icon', type: 'image/png', href: '/favicon-16x16.png', sizes: '16x16' }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
    ['meta', { name: 'theme-color', content: '#0b0c0e' }]
  ],

  // Keep the docs site consistently dark. (No toggle.)
  appearance: 'dark',

  themeConfig: {
    // Use the app's actual Raphael icon.
    logo: '/raphael-icon-192.png',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Hosting', link: '/hosting' }
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Ingest', link: '/guide/ingest' },
          { text: 'Drops', link: '/guide/drops' },
          { text: 'Auth', link: '/guide/auth' },
          { text: 'Screenshots', link: '/guide/screenshots' },
          { text: 'Troubleshooting', link: '/guide/troubleshooting' }
        ]
      },
      {
        text: 'Deploy',
        items: [{ text: 'Hosting', link: '/hosting' }]
      }
    ],
    socialLinks: [{ icon: 'github', link: `https://github.com/${githubRepo}` }]
    ,
    footer: {
      message: `MIT Licensed. Built & Maintained by ${maintainer}.`
    }
  }
});
