// Crypto polyfills for @noble / @privy / @solana — must come before any other import
import './shim';

import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
