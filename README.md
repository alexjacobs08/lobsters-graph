# Lobste.rs Invitation Graph

Interactive visualization of the [Lobste.rs](https://lobste.rs) user invitation network.

**[View Live Demo](https://alexjacobs08.github.io/lobsters-graph/)**

![Screenshot](https://github.com/alexjacobs08/lobsters-graph/raw/main/screenshot.png)

## Features

- **19,000+ users** visualized in a radial tree layout
- **Interactive exploration** - click users to see their stats and invitees
- **Descendant highlighting** - visualize someone's entire invitation tree with color-coded generations
- **Search** - find any user instantly
- **Filtering** - filter by minimum karma
- **Mobile friendly** - works on phones and tablets

## Stats Shown

- Karma and invite count
- Who invited them
- Generation (distance from founder)
- Top invitees
- **Invitation Tree** - total descendants and accumulated karma of everyone they've invited

## Tech Stack

- [Sigma.js](https://www.sigmajs.org/) v2.4.0 - WebGL graph rendering
- [Graphology](https://graphology.github.io/) - graph data structure
- Vanilla JS, HTML, CSS

## Local Development

```bash
cd docs
python3 -m http.server 8000
# Open http://localhost:8000
```

## Data

The graph data was scraped from the public [Lobste.rs user tree](https://lobste.rs/users/tree). Data is static as of December 2025.
