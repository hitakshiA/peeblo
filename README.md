# Peeblo site

The landing page for [Peeblo](https://peeblo.xyz): open-source AI teammates for Slack, self-hosted, with every model call going through [Otari](https://otari.ai).

Live at **[peeblo.xyz](https://peeblo.xyz)**.

## Run it

```sh
npm install
npm run dev
```

Then open http://localhost:3000.

`npm run check` runs lint, typecheck and a production build.

## Stack

- Next.js 16 (App Router), React 19, TypeScript
- Tailwind CSS 4 and CSS modules
- Characters from [Open Bot Avatar](https://github.com/DominikScholz/open-bot-avatar)

## Where things live

- `src/components/sections`: one file per section of the page
- `src/components/peeblo`: shared pieces (characters, receipts, cursor effects)
- `src/content`: the crew, models, integrations and links
- `public`: logos, model marks and people photos

Credits for fonts, icons, logos and photos are in [CREDITS.md](CREDITS.md).

## License

MIT. See [LICENSE](LICENSE).
