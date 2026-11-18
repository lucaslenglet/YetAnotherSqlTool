import ReactDOM from "react-dom/client";
import { VscodeWebviewProvider } from "../../common/vscodeWebviewProvider";
import { DashboardStateProvider } from "./dashboardStateProvider";
import { DashboardPage } from "./dashboardPage";
import "../../index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
    <VscodeWebviewProvider>
        <DashboardStateProvider>
            <DashboardPage />
        </DashboardStateProvider>
    </VscodeWebviewProvider>,
);
