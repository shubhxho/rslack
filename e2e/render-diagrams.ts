// Renders docs/diagrams/*.mmd to SVG with mermaid in headless Chrome (minimal neutral theme).
// Usage: npm run diagrams   (repo root, after `npm ci`)
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

/** The subset of the mermaid browser API used here. */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}
const require = createRequire(import.meta.url);
const dir = new URL('../docs/diagrams/', import.meta.url).pathname;
const mermaidJs = readFileSync(require.resolve('mermaid/dist/mermaid.min.js'), 'utf8');
const font = new URL('../web/fonts/Inter.woff2', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setContent(`<style>@font-face{font-family:Inter;src:url(data:font/woff2;base64,${readFileSync(font).toString('base64')})}</style><div id=o></div>`);
await page.addScriptTag({ content: mermaidJs });
await page.evaluate(() => document.fonts.ready);
for (const f of readdirSync(dir).filter((f) => f.endsWith('.mmd'))) {
  const src = readFileSync(dir + f, 'utf8');
  const svg = await page.evaluate(async ({ src, id }: { src: string; id: string }) => {
    const mermaid = (window as unknown as { mermaid: MermaidApi }).mermaid;
    mermaid.initialize({
      startOnLoad: false, theme: 'base', securityLevel: 'strict', fontFamily: 'Inter, sans-serif',
      flowchart: { htmlLabels: false, curve: 'basis', padding: 14, nodeSpacing: 40, rankSpacing: 56 },
      er: { useMaxWidth: false }, sequence: { useMaxWidth: false, mirrorActors: false, actorMargin: 60 },
      themeVariables: {
        fontFamily: 'Inter, sans-serif', fontSize: '14px', background: '#ffffff',
        primaryColor: '#ffffff', primaryBorderColor: '#cfcfcf', primaryTextColor: '#111111',
        secondaryColor: '#fafafa', tertiaryColor: '#fafafa', lineColor: '#8f8f8f', textColor: '#111111',
        clusterBkg: '#fafafa', clusterBorder: '#e3e3e3', edgeLabelBackground: '#ffffff',
        actorBkg: '#ffffff', actorBorder: '#cfcfcf', signalColor: '#6f6f6f', noteBkgColor: '#fdeee7', noteBorderColor: '#e5480b',
        attributeBackgroundColorOdd: '#ffffff', attributeBackgroundColorEven: '#fafafa',
      },
    });
    const { svg } = await mermaid.render(id, src);
    return svg;
  }, { src, id: 'd' + f.replace(/\W/g, '') });
  writeFileSync(dir + f.replace(/\.mmd$/, '.svg'), svg);
  console.log('rendered', f);
}
await browser.close();
