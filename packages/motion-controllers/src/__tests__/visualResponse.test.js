import Constants from '../constants';
import VisualResponse from '../visualResponse';

describe('Construction tests', () => {
  test('Fail to construct visual response when description is not provided', () => {
    expect(() => {
      // eslint-disable-next-line no-unused-vars
      const visualResponses = new VisualResponse(undefined);
    }).toThrow();

    expect(() => {
      // eslint-disable-next-line no-unused-vars
      const visualResponses = new VisualResponse(null);
    }).toThrow();

    expect(() => {
      // eslint-disable-next-line no-unused-vars
      const visualResponses = new VisualResponse({});
    }).toThrow();
  });
  test.each([
    ['button', 'state', 'xAxis', 'yAxis']
  ])('Create with %s source and no additional properties', (source) => {
    const responseDescription = {
      rootNodeName: 'ROOT',
      source,
      states: [Constants.ComponentState.DEFAULT]
    };

    const expectedResponse = Object.assign(responseDescription, {
      targetNodeName: 'ROOT',
      minNodeName: 'MIN',
      maxNodeName: 'MAX',
      property: 'transform'
    });

    const visualResponse = new VisualResponse(responseDescription);
    expect(visualResponse).toBeDefined();
    expect(visualResponse.description).toEqual(expectedResponse);
  });

  test('Create with explicit properties', () => {
    const responseDescription = {
      rootNodeName: 'ROOT',
      source: 'button',
      states: [Constants.ComponentState.DEFAULT],
      targetNodeName: 'TARGET',
      minNodeName: 'MY MIN NODE',
      maxNodeName: 'MY MAX NODE',
      property: 'visibility'
    };

    const visualResponse = new VisualResponse(responseDescription);
    expect(visualResponse).toBeDefined();
    expect(visualResponse.description).toMatchObject(responseDescription);
  });
});

describe('Weighting tests', () => {
  test('buttonValue', () => {
    const componentValues = {
      state: Constants.ComponentState.DEFAULT,
      button: 0.8
    };

    const responseDescription = {
      source: 'button',
      states: [Constants.ComponentState.DEFAULT],
      property: 'transform'
    };

    const visualResponse = new VisualResponse(responseDescription);

    visualResponse.updateFromComponent(componentValues);
    expect(visualResponse.value).toEqual(0.8);

    componentValues.state = Constants.ComponentState.TOUCHED;
    visualResponse.updateFromComponent(componentValues);
    expect(visualResponse.value).toEqual(0);
  });

  test('axis values in inactive state', () => {
    const componentValues = {
      state: Constants.ComponentState.TOUCHED,
      xAxis: 1,
      yAxis: 1
    };

    const xAxisResponseDescription = {
      source: 'xAxis',
      states: [Constants.ComponentState.DEFAULT],
      property: 'transform'
    };

    const yAxisResponseDescription = {
      source: 'yAxis',
      states: [Constants.ComponentState.DEFAULT],
      property: 'transform'
    };

    const xAxisResponse = new VisualResponse(xAxisResponseDescription);
    const yAxisResponse = new VisualResponse(yAxisResponseDescription);

    xAxisResponse.updateFromComponent(componentValues);
    expect(xAxisResponse.value).toEqual(0.5);

    yAxisResponse.updateFromComponent(componentValues);
    expect(yAxisResponse.value).toEqual(0.5);
  });

  /* eslint-disable indent */
  test.each`
    xAxis  | yAxis  | expectedX | expectedY
    ${0}   | ${0}   | ${0.5}    | ${0.5}
    ${-1}  | ${0}   | ${0}      | ${0.5}
    ${1}   | ${0}   | ${1}      | ${0.5}
    ${0}   | ${-1}  | ${0.5}    | ${0}
    ${0}   | ${1}   | ${0.5}    | ${1}
    ${1}   | ${-1}  | ${0.8536} | ${0.1464}
    ${-1}  | ${1}   | ${0.1464} | ${0.8536}
    ${1}   | ${1}   | ${0.8536} | ${0.8536}
    ${-1}  | ${-1}  | ${0.1464} | ${0.1464}
    ${0.2} | ${0.3} | ${0.6}    | ${0.65}
    ${1}   | ${1}   | ${0.8536} | ${0.8536}
    ${1}   | ${1}   | ${0.8536} | ${0.8536}
  `('axes values x=$xAxis y=$yAxis', ({
    xAxis, yAxis, expectedX, expectedY
  }) => {
    const componentValues = {
      state: Constants.ComponentState.DEFAULT,
      xAxis,
      yAxis
    };

    const xAxisResponseDescription = {
      source: 'xAxis',
      states: [Constants.ComponentState.DEFAULT],
      property: 'transform'
    };

    const yAxisResponseDescription = {
      source: 'yAxis',
      states: [Constants.ComponentState.DEFAULT],
      property: 'transform'
    };

    const xAxisResponse = new VisualResponse(xAxisResponseDescription);
    const yAxisResponse = new VisualResponse(yAxisResponseDescription);

    xAxisResponse.updateFromComponent(componentValues);
    yAxisResponse.updateFromComponent(componentValues);

    expect(xAxisResponse.value).toBeCloseTo(expectedX, 4);
    expect(yAxisResponse.value).toBeCloseTo(expectedY, 4);
  });
  /* eslint-enable */

  test('state for visibility property', () => {
    const componentValues = {
      state: Constants.ComponentState.DEFAULT
    };

    const responseDescription = {
      source: 'state',
      states: [Constants.ComponentState.DEFAULT],
      property: 'visibility'
    };

    const response = new VisualResponse(responseDescription);

    expect(response.value).toEqual(true);

    componentValues.state = Constants.ComponentState.TOUCHED;
    response.updateFromComponent(componentValues);
    expect(response.value).toEqual(false);
  });

  test('state for transform property', () => {
    const componentValues = {
      state: Constants.ComponentState.DEFAULT
    };

    const responseDescription = {
      source: 'state',
      states: [Constants.ComponentState.DEFAULT]
    };

    const response = new VisualResponse(responseDescription);

    expect(response.value).toEqual(1);

    componentValues.state = Constants.ComponentState.TOUCHED;
    response.updateFromComponent(componentValues);
    expect(response.value).toEqual(0);
  });
});
