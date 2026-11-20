import { Component, type ComponentChildren } from 'preact';
import { COPY } from '../content/copy.js';

interface Props {
  onReset: () => void;
  children: ComponentChildren;
}

/** Shows a plain message and a restart button instead of a blank page. */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static override getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(err: unknown) {
    console.error('Report render failed', err);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div class="oa-card oa-render-error" role="alert">
        <p>{COPY.errors.render}</p>
        <button
          type="button"
          class="oa-button oa-button--primary"
          onClick={() => {
            this.setState({ failed: false });
            this.props.onReset();
          }}
        >
          {COPY.errors.renderButton}
        </button>
      </div>
    );
  }
}
