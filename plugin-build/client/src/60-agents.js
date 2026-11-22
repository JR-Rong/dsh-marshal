    function SafeMarshalPanel(props) {
      return h(MarshalErrorBoundary, { resetKey: 'marshal-panel-root' }, h(MarshalPanel, props));
    }

