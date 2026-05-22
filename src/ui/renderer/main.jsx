import React from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import App from './App'
import './index.css'

// StrictMode disabilitato: doppio mount + bootstrap async causava crash hook in dev/HMR
createRoot(document.getElementById('root')).render(
  <HashRouter>
    <App />
  </HashRouter>
)
