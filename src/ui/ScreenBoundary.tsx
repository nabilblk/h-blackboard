import { Component, type ReactNode } from "react";
import { Button } from "./Button";

/** A rendering failure must not strand people or remove their workspace navigation. */
export class ScreenBoundary extends Component<
  { children: ReactNode; home: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="hb-screen-error" role="alert">
        <h1>This view couldn’t open.</h1>
        <p>
          Your saved work remains available. Try opening the view again, or
          return Home.
        </p>
        <Button
          variant="primary"
          onClick={() => this.setState({ failed: false })}
        >
          Try again
        </Button>{" "}
        <Button onClick={this.props.home}>Back to Home</Button>
      </section>
    );
  }
}
