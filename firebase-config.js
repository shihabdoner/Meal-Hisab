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
  { id: "khaddo", label: "খাদ্য তথ্য",   url: "https://script.google.com/macros/s/AKfycbz5YhnlSH6qsayE1V97ptZ1d2OrYFGfqrVdaBjs4rgKEjB3mALySM3ekTIzWGIthiVUdA/exec" },
  { id: "bazar",  label: "বেলা হিসাব", url: "https://script.google.com/macros/s/AKfycbzAoKyY1RCXVSMuhgV_z5hPcKXQ_LghwiVdmIqXbSLS7jrrndGgcBHt8ZVRClWW-AssEQ/exec" }
];
