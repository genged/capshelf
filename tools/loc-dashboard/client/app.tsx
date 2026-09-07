import { render } from "preact";
import "./styles.css";
import { Dashboard } from "./Dashboard";

const root = document.getElementById("app");
if (root) render(<Dashboard />, root);
