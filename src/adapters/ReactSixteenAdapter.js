/* eslint no-use-before-define: 0 */
import React from 'react';
import ReactDOM from 'react-dom';
import ReactDOMServer from 'react-dom/server';
// import TestRenderer from 'react-test-renderer';
import ShallowRenderer from 'react-test-renderer/shallow';
import TestUtils from 'react-dom/test-utils';
import PropTypes from 'prop-types';
import EnzymeAdapter from './EnzymeAdapter';
import elementToTree from './elementToTree';
import {
  mapNativeEventNames,
  propFromEvent,
  assertDomAvailable,
} from './Utils';

const HostRoot = 3;
const ClassComponent = 2;
const Fragment = 10;
const FunctionalComponent = 1;
const HostComponent = 5;
const HostText = 6;

function nodeAndSiblingsArray(nodeWithSibling) {
  const array = [];
  let node = nodeWithSibling;
  while (node != null) {
    array.push(node);
    node = node.sibling;
  }
  return array;
}

function flatten(arr) {
  const result = [];
  const stack = [{ i: 0, array: arr }];
  while (stack.length) {
    const n = stack.pop();
    while (n.i < n.array.length) {
      const el = n.array[n.i];
      n.i += 1;
      if (Array.isArray(el)) {
        stack.push(n);
        stack.push({ i: 0, array: el });
        break;
      }
      result.push(el);
    }
  }
  return result;
}

function toTree(vnode) {
  if (vnode == null) {
    return null;
  }
  // TODO(lmr): I'm not really sure I understand whether or not this is what
  // i should be doing, or if this is a hack for something i'm doing wrong
  // somewhere else. Should talk to sebastian about this perhaps
  const node = vnode.alternate !== null ? vnode.alternate : vnode;
  switch (node.tag) {
    case HostRoot: // 3
      return toTree(node.child);
    case ClassComponent:
      return {
        nodeType: 'class',
        type: node.type,
        props: { ...node.memoizedProps },
        instance: node.stateNode,
        rendered: childrenToTree(node.child),
      };
    case Fragment: // 10
      return childrenToTree(node.child);
    case FunctionalComponent: // 1
      return {
        nodeType: 'function',
        type: node.type,
        props: { ...node.memoizedProps },
        instance: null,
        rendered: childrenToTree(node.child),
      };
    case HostComponent: { // 5
      let renderedNodes = flatten(nodeAndSiblingsArray(node.child).map(toTree));
      if (renderedNodes.length === 0) {
        renderedNodes = [node.memoizedProps.children];
      }
      return {
        nodeType: 'host',
        type: node.type,
        props: { ...node.memoizedProps },
        instance: node.stateNode,
        rendered: renderedNodes,
      };
    }
    case HostText: // 6
      return node.memoizedProps;
    default:
      throw new Error(`Enzyme Internal Error: unknown node with tag ${node.tag}`);
  }
}

function childrenToTree(node) {
  if (!node) {
    return null;
  }
  const children = nodeAndSiblingsArray(node);
  if (children.length === 0) {
    return null;
  } else if (children.length === 1) {
    return toTree(children[0]);
  }
  return flatten(children.map(toTree));
}

function nodeToHostNode(_node) {
  // NOTE(lmr): node could be a function component
  // which wont have an instance prop, but we can get the
  // host node associated with its return value at that point.
  // Although this breaks down if the return value is an array,
  // as is possible with React 16.
  let node = _node;
  while (node && !Array.isArray(node) && node.instance === null) {
    node = node.rendered;
  }
  if (Array.isArray(node)) {
    // TODO(lmr): throw warning regarding not being able to get a host node here
    throw new Error('Trying to get host node of an array');
  }
  // if the SFC returned null effectively, there is no host node.
  if (!node) {
    return null;
  }
  return ReactDOM.findDOMNode(node.instance);
}

class SimpleWrapper extends React.Component {
  render() {
    return this.props.node || null;
  }
}

SimpleWrapper.propTypes = { node: PropTypes.node.isRequired };

class ReactSixteenAdapter extends EnzymeAdapter {
  createMountRenderer(options) {
    assertDomAvailable('mount');
    const domNode = options.attachTo || global.document.createElement('div');
    let instance = null;
    return {
      render(el/* , context */) {
        const wrappedEl = React.createElement(SimpleWrapper, {
          node: el,
        });
        instance = ReactDOM.render(wrappedEl, domNode);
      },
      unmount() {
        ReactDOM.unmountComponentAtNode(domNode);
      },
      getNode() {
        return toTree(instance._reactInternalInstance.child);
      },
      simulateEvent(node, event, mock) {
        const mappedEvent = mapNativeEventNames(event);
        const eventFn = TestUtils.Simulate[mappedEvent];
        if (!eventFn) {
          throw new TypeError(`ReactWrapper::simulate() event '${event}' does not exist`);
        }
        // eslint-disable-next-line react/no-find-dom-node
        eventFn(nodeToHostNode(node), mock);
      },
      batchedUpdates(fn) {
        return fn();
        // return ReactDOM.unstable_batchedUpdates(fn);
      },
    };
  }

  createShallowRenderer(/* options */) {
    const renderer = new ShallowRenderer();
    let isDOM = false;
    let cachedNode = null;
    return {
      render(el, context) {
        cachedNode = el;
        /* eslint consistent-return: 0 */
        if (typeof el.type === 'string') {
          isDOM = true;
        } else {
          isDOM = false;
          return renderer.render(el, context);
        }
      },
      unmount() {
        renderer.unmount();
      },
      getNode() {
        if (isDOM) {
          return elementToTree(cachedNode);
        }
        const output = renderer.getRenderOutput();
        return {
          nodeType: 'class',
          type: cachedNode.type,
          props: cachedNode.props,
          instance: renderer._instance,
          rendered: elementToTree(output),
        };
      },
      simulateEvent(node, event, ...args) {
        const handler = node.props[propFromEvent(event)];
        if (handler) {
          // withSetStateAllowed(() => {
            // TODO(lmr): create/use synthetic events
            // TODO(lmr): emulate React's event propagation
            // ReactDOM.unstable_batchedUpdates(() => {
          handler(...args);
            // });
          // });
        }
      },
      batchedUpdates(fn) {
        return fn();
        // return ReactDOM.unstable_batchedUpdates(fn);
      },
    };
  }

  createStringRenderer(/* options */) {
    return {
      render(el /* , context */) {
        return ReactDOMServer.renderToStaticMarkup(el);
      },
    };
  }

  // Provided a bag of options, return an `EnzymeRenderer`. Some options can be implementation
  // specific, like `attach` etc. for React, but not part of this interface explicitly.
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  createRenderer(options) {
    switch (options.mode) {
      case 'mount': return this.createMountRenderer(options);
      case 'shallow': return this.createShallowRenderer(options);
      case 'string': return this.createStringRenderer(options);
      default:
        throw new Error('Unrecognized mode');
    }
  }

  // converts an RSTNode to the corresponding JSX Pragma Element. This will be needed
  // in order to implement the `Wrapper.mount()` and `Wrapper.shallow()` methods, but should
  // be pretty straightforward for people to implement.
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  nodeToElement(node) {
    if (!node || typeof node !== 'object') return null;
    return React.createElement(node.type, node.props);
  }

  elementToNode(element) {
    return elementToTree(element);
  }

  nodeToHostNode(node) {
    return nodeToHostNode(node);
  }
}

module.exports = ReactSixteenAdapter;
