import { render } from "preact";
import "./styles.css";
import { bootstrapToken } from "./api";
import { Dashboard } from "./dashboard";

bootstrapToken();

const root = document.getElementById("app");
if (root) render(<Dashboard />, root);
