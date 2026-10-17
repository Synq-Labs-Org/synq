---
title: Themes
description: Choose the look of the iPhone app, iMessage extension and web hub: ASCII, Paper, Holo and Ledger, saved on your device.
---

Synq separates **function** from **look**. Every screen is layout and plain-English copy; a theme supplies colours, type, spacing, radii, decorative glyphs, flavour text and artwork. Changing theme never changes an amount, a network label or an approval text.

## The themes

| Theme  | iPhone and iMessage | Web | Character                                       |
| ------ | ------------------- | --- | ----------------------------------------------- |
| ASCII  | Yes                 | Yes | Black terminal, monospace type, character art   |
| Paper  | Yes                 | Yes | Light print look, serif type, riso-style art    |
| Holo   | Yes                 | Yes | Violet glass, rounded type, symbol art          |
| Ledger | No                  | Yes | Plain light accounting look with serif headings |

The iPhone app starts in **Paper**; the Messages extension starts in the first theme in the list (ASCII). The docs site defaults to ASCII.

## Changing it

- **iPhone app:** Account, then **Theme**. Each option previews in its own theme. The choice is saved on the device as `synq.theme`.
- **iMessage extension:** keeps its own choice.
- **Web hub:** Settings, then **Appearance**, or the theme picker in the header. The choice is stored in your browser's local storage under `synq.theme`. This documentation reads the same value.

## What a theme cannot change

Exact amounts, the network label (always "Arc testnet" here), the execution mode and every approval text are always shown in English and in the same place. Art is decorative and hidden from assistive technology, and uses no copyrighted images.

## For developers

A new look is a new theme module rather than a change to screens. On iOS that is a type conforming to `SynqTheme` registered in `SynqThemes.all`. On the web it is a set of design tokens under a new `data-theme` value. See `apps/ios-messages/THEMING.md` in the repository for the iOS rules, including the art slots and the font licence requirement.
