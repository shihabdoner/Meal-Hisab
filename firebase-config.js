// Firebase is used only for Google sign-in. Each Google Sheet is its own database.
export const firebaseConfig = {
  apiKey: "AIzaSyAfp6ACmE3d-9iAieAp1knA40qKEbdcx7Y",
  authDomain: "khaddo-tothyo.firebaseapp.com",
  projectId: "khaddo-tothyo",
  storageBucket: "khaddo-tothyo.firebasestorage.app",
  messagingSenderId: "221896509109",
  appId: "1:221896509109:web:a36edd0b6f0ab4a8c020fc"
};

// Every spreadsheet has its own Apps Script "Web app" URL (ends with /exec).
// The site shows a "Sheet" switcher when more than one URL is filled in.
export const BOOKS = [
  { id: "khaddo", label: "খাদ্য তথ্য",   url: "https://script.google.com/macros/s/AKfycbzXIaOWoxbvjR2TfpC4zm7Rg9a8mC09Bna3TTr-z91Jh-Sx-m3c6k0HcWV8Wqw-TL9m7g/exec" },
  { id: "bazar",  label: "বেলা হিসাব", url: "https://script.google.com/macros/s/AKfycbxAbFxYNA789CF0J2FFdgghsaCkIpd_VCUhm-SSPC-019YH2JkuOhQXYZ4Sg5OTP3NoCg/exec" }
];
export const VAPID_KEY = "BE1R54O5RwshUMeCeEqkZ7kvkWgAe3mAR1LtPiI-uTCbVLMyW6K27L29qq160-p7CeW7o9YqeXZJMGoz0jhfeiQ";

// SQL API (Supabase Edge Function). Empty = the app cannot save.
export const SQL_API_URL = "https://szzccmkdouvmzluabuyi.supabase.co/functions/v1/api";
