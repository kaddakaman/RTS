import './style.css';
import { Game } from './game';
import { initNative } from './native';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const game = new Game(canvas, ui);
game.start();
initNative(game);

// Handy for debugging and automated smoke tests.
(window as any).SF = game;
