# Logo Loader Component

A reusable, premium loading screen component featuring the school logo with animated spinner.

## Files

- **CSS:** `assets/css/components/logo-loader.css`
- **JS:** `assets/js/components/logo-loader.js`

## Usage

### 1. Include the CSS

```html
<link rel="stylesheet" href="assets/css/components/logo-loader.css" />
```

### 2. Include the JavaScript

```html
<script src="assets/js/components/logo-loader.js"></script>
```

### 3. Add the HTML (optional)

The JavaScript creates the loader automatically. Existing pages may provide the
markup below when they need a custom logo path or accessible label.

```html
<div class="logo-loader" id="logoLoader" aria-hidden="true">
    <div class="logo-loader-content">
        <img src="assets/img/logo/logo.png" alt="School Logo" class="logo-loader-image" />
    </div>
</div>
```

### 4. Customization

#### Auto-initialization (Default)
The loader starts immediately when the component script runs and automatically
hides after the browser fires `window.load`.

#### Manual Control
```html
<script>
    // Manually hide the loader
    hideLogoLoader();
    
    // Manually show the loader
    showLogoLoader();
</script>
```

## Features

- **Responsive:** Works on all screen sizes
- **Accessible:** Respects `prefers-reduced-motion` preferences
- **Customizable:** Easy to adjust duration, colors, and sizing
- **Performance:** GPU-accelerated animations
- **Reusable:** Can be used across multiple pages/modules

## Customization Options

### Logo Size
Edit in `logo-loader.css`:
```css
.logo-loader-image {
    width: 180px;  /* Adjust size */
    height: 180px; /* Adjust size */
}
```

### Spinner Color
Edit in `logo-loader.css`:
```css
.logo-loader-content::before {
    border-top-color: #0055a4; /* Change to your brand color */
}
```

### Background Color
Edit in `logo-loader.css`:
```css
.logo-loader {
    background: #d7d9dc; /* Change to your preferred background */
}
```

## Loading behavior

- The loader stays visible while the browser is loading the document and its dependent resources.
- It stays visible for at least 1 second, even when the page loads faster.
- It hides only when both the 1-second minimum and the browser `window.load` event have completed.
- Slow browser loads keep it visible indefinitely until the page actually loads.

## Animation Timing

- Logo reveal: 0.6s with bounce effect
- Spinner reveal: 0.4s fade-in
- Spinner rotation: 0.8s per revolution
- Minimum display: 1 second
- Hide transition: 350ms after both loading conditions are met

## Browser Support

- Modern browsers (Chrome, Firefox, Safari, Edge)
- IE11+ (with appropriate polyfills)
- Mobile browsers (iOS Safari, Chrome Mobile)
