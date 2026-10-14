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
  { id: "khaddo", label: "খাদ্য তথ্য",   url: "https://script.google.com/macros/s/AKfycby2l_Gj85s_XSgedwaHlMMd_c_mCRprO3VrBjw07EVfDY8BcyJb019BYDPM0xmz6khf/exec" },
  { id: "bazar",  label: "বেলা হিসাব", url: "https://script.google.com/macros/s/AKfycbypVjlK4_RNuxRrxHWHA6VJRk7VPIZtWXm25AlUqFPUlpEFFi8kH0t6QK6-0BoD-P7q/exec" }
];
