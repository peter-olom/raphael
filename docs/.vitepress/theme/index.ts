import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import './custom.css';
import UiTour from './components/UiTour.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('UiTour', UiTour);
  }
} satisfies Theme;
