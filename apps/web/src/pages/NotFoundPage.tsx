import { Topbar } from "../shell/Topbar.js";
import { NotFoundState } from "../ui/states.js";

export function NotFoundPage() {
  return (
    <>
      <Topbar crumbs={[{ label: "Not found" }]} />
      <div className="content">
        <NotFoundState
          title="Page not found"
          message="That route does not exist in this read-only DevChestra viewer."
          backTo="/"
          backLabel="Back to projects"
        />
      </div>
    </>
  );
}
