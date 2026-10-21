import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '@fontsource-variable/inter'
import '@fontsource-variable/noto-sans-sc'
import './styles.css'
import './books-design.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
