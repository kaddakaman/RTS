// Integration with the Android app shell (Capacitor). Does nothing in a browser.

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import type { Game } from './game';

export const isNative = Capacitor.isNativePlatform();

export function initNative(game: Game): void {
  if (!isNative) return;
  document.documentElement.classList.add('native');
  // Android's Back button closes menus / cancels / pauses instead of quitting.
  void App.addListener('backButton', () => {
    if (!game.back()) void App.minimizeApp();
  });
  // Pause single-player games when the app goes to the background.
  void App.addListener('pause', () => {
    if (game.mode === 'local') game.pause();
  });
}
