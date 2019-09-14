import { fetchProfile, MotionController, fetchProfilesList, Constants } from './motion-controllers.module.js';
import './ajv/ajv.min.js';
import mergeProfile from './profilesTools/mergeProfile.js';
import { PerspectiveCamera, Scene, Color, WebGLRenderer, DirectionalLight, SphereGeometry, MeshBasicMaterial, Mesh, Quaternion } from './three/build/three.module.js';
import { GLTFLoader } from './three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from './three/examples/jsm/controls/OrbitControls.js';

/**
 * A false gamepad to be used in tests
 */
class MockGamepad {
  /**
   * @param {Object} profileDescription - The profile description to parse to determine the length
   * of the button and axes arrays
   * @param {string} handedness - The gamepad's handedness
   */
  constructor(profileDescription, handedness) {
    if (!profileDescription) {
      throw new Error('No profileDescription supplied');
    }

    if (!handedness) {
      throw new Error('No handedness supplied');
    }

    this.id = profileDescription.profileId;

    // Loop through the profile description to determine how many elements to put in the buttons
    // and axes arrays
    let maxButtonIndex = 0;
    let maxAxisIndex = 0;
    const layout = profileDescription.layouts[handedness];
    this.mapping = layout.mapping;
    Object.values(layout.components).forEach(({ gamepadIndices }) => {
      if (gamepadIndices.button !== undefined && gamepadIndices.button > maxButtonIndex) {
        maxButtonIndex = gamepadIndices.button;
      }

      if (gamepadIndices.xAxis !== undefined && (gamepadIndices.xAxis > maxAxisIndex)) {
        maxAxisIndex = gamepadIndices.xAxis;
      }

      if (gamepadIndices.yAxis !== undefined && (gamepadIndices.yAxis > maxAxisIndex)) {
        maxAxisIndex = gamepadIndices.yAxis;
      }
    });

    // Fill the axes array
    this.axes = [];
    while (this.axes.length <= maxAxisIndex) {
      this.axes.push(0);
    }

    // Fill the buttons array
    this.buttons = [];
    while (this.buttons.length <= maxButtonIndex) {
      this.buttons.push({
        value: 0,
        touched: false,
        pressed: false
      });
    }
  }
}

/**
 * A fake XRInputSource that can be used to initialize a MotionController
 */
class MockXRInputSource {
  /**
   * @param {Object} gamepad - The Gamepad object that provides the button and axis data
   * @param {string} handedness - The handedness to report
   */
  constructor(gamepad, handedness) {
    this.gamepad = gamepad;

    if (!handedness) {
      throw new Error('No handedness supplied');
    }

    this.handedness = handedness;
    this.profiles = Object.freeze([this.gamepad.id]);
  }
}

const errorsElementId = 'errors';
let listElement;

function toggleVisibility() {
  const errorsElement = document.getElementById(errorsElementId);
  errorsElement.hidden = errorsElement.children.length === 0;
}

function addErrorElement(errorMessage) {
  const errorsElement = document.getElementById(errorsElementId);
  if (!listElement) {
    listElement = document.createElement('ul');
    errorsElement.appendChild(listElement);
  }

  const itemElement = document.createElement('li');
  itemElement.innerText = errorMessage;
  listElement.appendChild(itemElement);

  toggleVisibility();
}

const ErrorLogging = {
  log: (errorMessage) => {
    addErrorElement(errorMessage);

    /* eslint-disable-next-line no-console */
    console.error(errorMessage);
  },

  throw: (errorMessage) => {
    addErrorElement(errorMessage);
    throw new Error(errorMessage);
  },

  clear: () => {
    if (listElement) {
      const errorsElement = document.getElementById(errorsElementId);
      errorsElement.removeChild(listElement);
      listElement = undefined;
    }
    toggleVisibility();
  },

  clearAll: () => {
    const errorsElement = document.getElementById(errorsElementId);
    errorsElement.innerHTML = '';
    listElement = undefined;
    toggleVisibility();
  }
};

/**
 * Adds a selector for choosing the handedness of the provided profile
 */
class HandednessSelector {
  constructor(parentSelectorType) {
    this.selectorType = parentSelectorType;

    // Create the handedness selector and watch for changes
    this.element = document.createElement('select');
    this.element.id = `${this.selectorType}HandednessSelector`;
    this.element.addEventListener('change', () => { this.onHandednessSelected(); });

    this.clearSelectedProfile();
  }

  /**
   * Fires an event notifying that the handedness has changed
   */
  fireHandednessChange() {
    const changeEvent = new CustomEvent('handednessChange', { detail: this.handedness });
    this.element.dispatchEvent(changeEvent);
  }

  clearSelectedProfile() {
    this.selectedProfile = null;
    this.handednessStorageKey = null;
    this.element.disabled = true;
    this.element.innerHTML = '<option value="loading">Loading...</option>';
    this.fireHandednessChange(null);
  }

  /**
   * Responds to changes in the dropdown, saves the value to local storage, and triggers the event
   */
  onHandednessSelected() {
    // Create a mock gamepad that matches the profile and handedness
    this.handedness = this.element.value;
    window.localStorage.setItem(this.handednessStorageKey, this.handedness);
    this.fireHandednessChange();
  }

  /**
   * Sets the profile from which handedness needs to be selected
   * @param {object} profile
   */
  setSelectedProfile(profile) {
    this.clearSelectedProfile();
    this.selectedProfile = profile;

    // Load and clear the last selection for this profile id
    this.handednessStorageKey = `${this.selectorType}_${this.selectedProfile.id}_handedness`;
    const storedHandedness = window.localStorage.getItem(this.handednessStorageKey);
    window.localStorage.removeItem(this.handednessStorageKey);

    // Populate handedness selector
    this.element.innerHTML = '';
    Object.keys(this.selectedProfile.layouts).forEach((handedness) => {
      this.element.innerHTML += `
        <option value='${handedness}'>${handedness}</option>
      `;
    });

    if (this.element.children.length === 0) {
      ErrorLogging.log(`No handedness values found for profile ${this.selectedProfile.id}`);
    }

    // Apply stored handedness if found
    if (storedHandedness && this.selectedProfile.layouts[storedHandedness]) {
      this.element.value = storedHandedness;
    }

    // Manually trigger the handedness to change
    this.element.disabled = false;
    this.onHandednessSelected();
  }
}

/* eslint-disable import/no-unresolved */

const profileIdStorageKey = 'repository_profileId';
const profilesBasePath = './profiles';
/**
 * Loads profiles from the distribution folder next to the viewer's location
 */
class RepositorySelector {
  constructor() {
    this.element = document.getElementById('repository');

    // Get the profile id dropdown and listen for changes
    this.profileIdSelectorElement = document.getElementById('repositoryProfileIdSelector');
    this.profileIdSelectorElement.addEventListener('change', () => { this.onProfileIdSelected(); });

    // Add a handedness selector and listen for changes
    this.handednessSelector = new HandednessSelector('repository');
    this.element.appendChild(this.handednessSelector.element);
    this.handednessSelector.element.addEventListener('handednessChange', (event) => { this.onHandednessChange(event); });

    this.disabled = true;
    this.clearSelectedProfile();
  }

  enable() {
    this.element.hidden = false;
    this.disabled = false;
    this.populateProfileSelector();
  }

  disable() {
    this.element.hidden = true;
    this.disabled = true;
    this.clearSelectedProfile();
  }

  clearSelectedProfile() {
    ErrorLogging.clearAll();
    this.selectedProfile = null;
    this.profileIdSelectorElement.disabled = true;
    this.handednessSelector.clearSelectedProfile();
  }

  /**
   * Responds to changes in selected handedness.
   * Creates a new motion controller for the combination of profile and handedness, and fires an
   * event to signal the change
   * @param {object} event
   */
  onHandednessChange(event) {
    if (!this.disabled) {
      let motionController;
      const handedness = event.detail;

      // Create motion controller if a handedness has been selected
      if (handedness) {
        const mockGamepad = new MockGamepad(this.selectedProfile, handedness);
        const mockXRInputSource = new MockXRInputSource(mockGamepad, handedness);

        fetchProfile(mockXRInputSource, profilesBasePath).then(({ profile, assetPath }) => {
          motionController = new MotionController(
            mockXRInputSource,
            profile,
            assetPath
          );

          // Signal the change
          const changeEvent = new CustomEvent(
            'motionControllerChange',
            { detail: motionController }
          );
          this.element.dispatchEvent(changeEvent);
        });
      } else {
        // Signal the change
        const changeEvent = new CustomEvent('motionControllerChange', { detail: null });
        this.element.dispatchEvent(changeEvent);
      }
    }
  }

  /**
   * Handler for the profile id selection change
   */
  onProfileIdSelected() {
    this.clearSelectedProfile();

    const profileId = this.profileIdSelectorElement.value;
    window.localStorage.setItem(profileIdStorageKey, profileId);

    // Attempt to load the profile
    fetchProfile({ profiles: [profileId] }, profilesBasePath, false).then(({ profile }) => {
      this.selectedProfile = profile;
      this.handednessSelector.setSelectedProfile(this.selectedProfile);
    })
      .catch((error) => {
        ErrorLogging.log(error.message);
        throw error;
      })
      .finally(() => {
        this.profileIdSelectorElement.disabled = false;
      });
  }

  /**
   * Retrieves the full list of available profiles
   */
  populateProfileSelector() {
    this.clearSelectedProfile();

    // Load and clear local storage
    const storedProfileId = window.localStorage.getItem(profileIdStorageKey);
    window.localStorage.removeItem(profileIdStorageKey);

    // Load the list of profiles
    this.profileIdSelectorElement.innerHTML = '<option value="loading">Loading...</option>';
    fetchProfilesList(profilesBasePath).then((profilesList) => {
      this.profileIdSelectorElement.innerHTML = '';
      Object.keys(profilesList).forEach((profileId) => {
        this.profileIdSelectorElement.innerHTML += `
        <option value='${profileId}'>${profileId}</option>
        `;
      });

      // Override the default selection if values were present in local storage
      if (storedProfileId) {
        this.profileIdSelectorElement.value = storedProfileId;
      }

      // Manually trigger selected profile to load
      this.onProfileIdSelected();
    })
      .catch((error) => {
        ErrorLogging.log(error.message);
        throw error;
      });
  }
}

/* eslint-disable import/no-unresolved */

/**
 * Loads selected file from filesystem and sets it as the selected profile
 * @param {Object} jsonFile
 */
function loadLocalJson(jsonFile) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const json = JSON.parse(reader.result);
      resolve(json);
    };

    reader.onerror = () => {
      const errorMessage = `Unable to load JSON from ${jsonFile.name}`;
      ErrorLogging.logError(errorMessage);
      reject(errorMessage);
    };

    reader.readAsText(jsonFile);
  });
}

async function buildSchemaValidator() {
  const schemasPath = 'profilesTools/schemas.json';
  const response = await fetch(schemasPath);
  if (!response.ok) {
    ErrorLogging.throw(response.statusText);
  }

  // eslint-disable-next-line no-undef
  const ajv = new Ajv();
  const schemas = await response.json();
  schemas.dependencies.forEach((schema) => {
    ajv.addSchema(schema);
  });

  return ajv.compile(schemas.mainSchema);
}

/**
 * Loads a profile from a set of local files
 */
class LocalProfileSelector {
  constructor() {
    this.element = document.getElementById('localProfile');
    this.localFilesListElement = document.getElementById('localFilesList');

    // Get the assets selector and watch for changes
    this.registryJsonSelector = document.getElementById('localProfileRegistryJsonSelector');
    this.registryJsonSelector.addEventListener('change', () => { this.onRegistryJsonSelected(); });

    // Get the asset json  selector and watch for changes
    this.assetJsonSelector = document.getElementById('localProfileAssetJsonSelector');
    this.assetJsonSelector.addEventListener('change', () => { this.onAssetJsonSelected(); });

    // Get the registry json selector and watch for changes
    this.assetsSelector = document.getElementById('localProfileAssetsSelector');
    this.assetsSelector.addEventListener('change', () => { this.onAssetsSelected(); });

    // Add a handedness selector and listen for changes
    this.handednessSelector = new HandednessSelector('localProfile');
    this.handednessSelector.element.addEventListener('handednessChange', (event) => { this.onHandednessChange(event); });
    this.element.insertBefore(this.handednessSelector.element, this.localFilesListElement);

    this.disabled = true;

    this.clearSelectedProfile();

    buildSchemaValidator().then((schemaValidator) => {
      this.schemaValidator = schemaValidator;
      // TODO figure out disabled thing
      this.onRegistryJsonSelected();
      this.onAssetJsonSelected();
      this.onAssetsSelected();
    });
  }

  enable() {
    this.element.hidden = false;
    this.disabled = false;
  }

  disable() {
    this.element.hidden = true;
    this.disabled = true;
    this.clearSelectedProfile();
  }

  clearSelectedProfile() {
    ErrorLogging.clearAll();
    this.registryJson = null;
    this.assetJson = null;
    this.mergedProfile = null;
    this.assets = [];
    this.handednessSelector.clearSelectedProfile();
  }

  createMotionController() {
    let motionController;
    if (this.handednessSelector.handedness && this.mergedProfile) {
      const { handedness } = this.handednessSelector;
      const mockGamepad = new MockGamepad(this.mergedProfile, handedness);
      const mockXRInputSource = new MockXRInputSource(mockGamepad, handedness);

      const assetName = this.mergedProfile.layouts[handedness].path;
      const assetUrl = this.assets[assetName];
      motionController = new MotionController(mockXRInputSource, this.mergedProfile, assetUrl);
    }

    const changeEvent = new CustomEvent('motionControllerChange', { detail: motionController });
    this.element.dispatchEvent(changeEvent);
  }

  /**
   * Responds to changes in selected handedness.
   * Creates a new motion controller for the combination of profile and handedness, and fires an
   * event to signal the change
   * @param {object} event
   */
  onHandednessChange() {
    if (!this.disabled) {
      this.createMotionController();
    }
  }

  async mergeJsonProfiles() {
    if (this.registryJson && this.assetJson) {
      try {
        this.mergedProfile = mergeProfile(this.registryJson, this.assetJson);
        this.handednessSelector.setSelectedProfile(this.mergedProfile);
      } catch (error) {
        ErrorLogging.log(error);
        throw error;
      }
    }
  }

  onRegistryJsonSelected() {
    if (!this.element.disabled) {
      this.registryJson = null;
      this.mergedProfile = null;
      this.handednessSelector.clearSelectedProfile();
      if (this.registryJsonSelector.files.length > 0) {
        loadLocalJson(this.registryJsonSelector.files[0]).then((registryJson) => {
          // TODO validate JSON
          this.registryJson = registryJson;
          this.mergeJsonProfiles();
        });
      }
    }
  }

  onAssetJsonSelected() {
    if (!this.element.disabled) {
      this.assetJson = null;
      this.mergedProfile = null;
      this.handednessSelector.clearSelectedProfile();
      if (this.assetJsonSelector.files.length > 0) {
        loadLocalJson(this.assetJsonSelector.files[0]).then((assetJson) => {
          const valid = this.schemaValidator(assetJson);
          if (!valid) {
            ErrorLogging.log(this.schemaValidator.error);
          } else {
            this.assetJson = assetJson;
            this.mergeJsonProfiles();
          }
        });
      }
    }
  }

  /**
   * Handles changes to the set of local files selected
   */
  onAssetsSelected() {
    if (!this.element.disabled) {
      const fileList = Array.from(this.assetsSelector.files);
      this.assets = [];
      fileList.forEach((file) => {
        this.assets[file.name] = window.URL.createObjectURL(file);
      });
      this.createMotionController();
    }
  }
}

/* eslint-disable import/no-unresolved */

const three = {};
let canvasParentElement;
let activeModel;

/**
 * @description Attaches a small blue sphere to the point reported as touched on all touchpads
 * @param {Object} model - The model to add dots to
 * @param {Object} motionController - A MotionController to be displayed and animated
 * @param {Object} rootNode - The root node in the asset to be animated
 */
function addTouchDots({ motionController, rootNode }) {
  Object.keys(motionController.components).forEach((componentId) => {
    const component = motionController.components[componentId];
    // Find the touchpads
    if (component.type === Constants.ComponentType.TOUCHPAD) {
      // Find the node to attach the touch dot.
      const componentRoot = rootNode.getObjectByName(component.rootNodeName, true);

      if (!componentRoot) {
        ErrorLogging.log(`Could not find root node of touchpad component ${component.rootNodeName}`);
        return;
      }

      const touchPointRoot = componentRoot.getObjectByName(component.touchPointNodeName, true);
      if (!touchPointRoot) {
        ErrorLogging.log(`Could not find touch dot, ${component.touchPointNodeName}, in touchpad component ${componentId}`);
      } else {
        const sphereGeometry = new SphereGeometry(0.001);
        const material = new MeshBasicMaterial({ color: 0x0000FF });
        const sphere = new Mesh(sphereGeometry, material);
        touchPointRoot.add(sphere);
      }
    }
  });
}

/**
 * @description Walks the model's tree to find the nodes needed to animate the components and
 * saves them for use in the frame loop
 * @param {Object} model - The model to find nodes in
 */
function findNodes(model) {
  const nodes = {};

  // Loop through the components and find the nodes needed for each components' visual responses
  Object.values(model.motionController.components).forEach((component) => {
    const componentRootNode = model.rootNode.getObjectByName(component.rootNodeName, true);
    const componentNodes = {};

    // If the root node cannot be found, skip this component
    if (!componentRootNode) {
      ErrorLogging.log(`Could not find root node of component ${component.rootNodeName}`);
      return;
    }

    // Loop through all the visual responses to be applied to this component
    Object.values(component.visualResponses).forEach((visualResponse) => {
      const visualResponseNodes = {};
      const { rootNodeName, targetNodeName, property } = visualResponse.description;

      // Find the node at the top of the visualization
      if (rootNodeName === component.root) {
        visualResponseNodes.rootNode = componentRootNode;
      } else {
        visualResponseNodes.rootNode = componentRootNode.getObjectByName(rootNodeName, true);
      }

      // If the root node cannot be found, skip this animation
      if (!visualResponseNodes.rootNode) {
        ErrorLogging.log(`Could not find root node of visual response for ${rootNodeName}`);
        return;
      }

      // Find the node to be changed
      visualResponseNodes.targetNode = visualResponseNodes.rootNode.getObjectByName(targetNodeName);

      // If animating a transform, find the two nodes to be interpolated between.
      if (property === 'transform') {
        const { minNodeName, maxNodeName } = visualResponse.description;
        visualResponseNodes.minNode = visualResponseNodes.rootNode.getObjectByName(minNodeName);
        visualResponseNodes.maxNode = visualResponseNodes.rootNode.getObjectByName(maxNodeName);

        // If the extents cannot be found, skip this animation
        if (!visualResponseNodes.minNode || !visualResponseNodes.maxNode) {
          ErrorLogging.log(`Could not find extents nodes of visual response for ${rootNodeName}`);
          return;
        }
      }

      // Add the animation to the component's nodes dictionary
      componentNodes[rootNodeName] = visualResponseNodes;
    });

    // Add the component's animations to the controller's nodes dictionary
    nodes[component.id] = componentNodes;
  });

  return nodes;
}


function clear() {
  if (activeModel) {
    // Remove any existing model from the scene
    three.scene.remove(activeModel.rootNode);

    // Set the page element with controller data for debugging
    const dataElement = document.getElementById('data');
    dataElement.innerHTML = '';

    activeModel = null;
  }

  ErrorLogging.clear();
}
/**
 * @description Event handler for window resizing.
 */
function onResize() {
  const width = canvasParentElement.clientWidth;
  const height = canvasParentElement.clientHeight;
  three.camera.aspectRatio = width / height;
  three.camera.updateProjectionMatrix();
  three.renderer.setSize(width, height);
  three.controls.update();
}

/**
 * @description Callback which runs the rendering loop. (Passed into window.requestAnimationFrame)
 */
function animationFrameCallback() {
  window.requestAnimationFrame(animationFrameCallback);

  if (activeModel) {
    // Cause the MotionController to poll the Gamepad for data
    activeModel.motionController.updateFromGamepad();

    // Set the page element with controller data for debugging
    const dataElement = document.getElementById('data');
    dataElement.innerHTML = JSON.stringify(activeModel.motionController.data, null, 2);

    // Update the 3D model to reflect the button, thumbstick, and touchpad state
    Object.values(activeModel.motionController.components).forEach((component) => {
      const componentNodes = activeModel.nodes[component.id];

      // Skip if the component node is not found. No error is needed, because it
      // will have been reported at load time.
      if (!componentNodes) return;

      // Update node data based on the visual responses' current states
      Object.values(component.visualResponses).forEach((visualResponse) => {
        const { description, value } = visualResponse;
        const visualResponseNodes = componentNodes[description.rootNodeName];

        // Skip if the visual response node is not found. No error is needed,
        // because it will have been reported at load time.
        if (!visualResponseNodes) return;

        // Calculate the new properties based on the weight supplied
        if (description.property === 'visibility') {
          visualResponseNodes.targetNode.visible = value;
        } else if (description.property === 'transform') {
          Quaternion.slerp(
            visualResponseNodes.minNode.quaternion,
            visualResponseNodes.maxNode.quaternion,
            visualResponseNodes.targetNode.quaternion,
            value
          );

          visualResponseNodes.targetNode.position.lerpVectors(
            visualResponseNodes.minNode.position,
            visualResponseNodes.maxNode.position,
            value
          );
        }
      });
    });
  }

  three.renderer.render(three.scene, three.camera);
  three.controls.update();
}

const ModelViewer = {
  initialize: () => {
    canvasParentElement = document.getElementById('modelViewer');
    const width = canvasParentElement.clientWidth;
    const height = canvasParentElement.clientHeight;

    // Set up the THREE.js infrastructure
    three.camera = new PerspectiveCamera(75, width / height, 0.01, 1000);
    three.camera.position.y = 0.5;
    three.scene = new Scene();
    three.scene.background = new Color(0x00aa44);
    three.renderer = new WebGLRenderer({ antialias: true });
    three.renderer.setSize(width, height);
    three.renderer.gammaOutput = true;
    three.loader = new GLTFLoader();

    // Set up the controls for moving the scene around
    three.controls = new OrbitControls(three.camera, three.renderer.domElement);
    three.controls.enableDamping = true;
    three.controls.minDistance = 0.05;
    three.controls.maxDistance = 0.3;
    three.controls.enablePan = false;
    three.controls.update();

    // Set up the lights so the model can be seen
    const bottomDirectionalLight = new DirectionalLight(0xFFFFFF, 2);
    bottomDirectionalLight.position.set(0, -1, 0);
    three.scene.add(bottomDirectionalLight);
    const topDirectionalLight = new DirectionalLight(0xFFFFFF, 2);
    three.scene.add(topDirectionalLight);

    // Add the THREE.js canvas to the page
    canvasParentElement.appendChild(three.renderer.domElement);
    window.addEventListener('resize', onResize, false);

    // Start pumping frames
    window.requestAnimationFrame(animationFrameCallback);
  },

  loadModel: async (motionController) => {
    try {
      const gltfAsset = await new Promise(((resolve, reject) => {
        three.loader.load(
          motionController.assetUrl,
          (loadedAsset) => { resolve(loadedAsset); },
          null,
          () => { reject(new Error(`Asset ${motionController.assetUrl} missing or malformed.`)); }
        );
      }));

      // Remove any existing model from the scene
      clear();

      const model = {
        motionController,
        rootNode: gltfAsset.scene
      };

      model.nodes = findNodes(model);
      addTouchDots(model);

      // Set the new model
      activeModel = model;
      three.scene.add(activeModel.rootNode);
    } catch (error) {
      ErrorLogging.throw(error);
    }
  },

  clear
};

let controlsListElement;
let mockGamepad;

function onButtonTouched(event) {
  const { index } = event.target.dataset;
  mockGamepad.buttons[index].touched = event.target.checked;
}

function onButtonPressed(event) {
  const { index } = event.target.dataset;
  mockGamepad.buttons[index].pressed = event.target.checked;
}

function onButtonValueChange(event) {
  const { index } = event.target.dataset;
  mockGamepad.buttons[index].value = Number(event.target.value);
}

function onAxisValueChange(event) {
  const { index } = event.target.dataset;
  mockGamepad.axes[index] = Number(event.target.value);
}

function clear$1() {
  if (!controlsListElement) {
    controlsListElement = document.getElementById('controlsList');
  }
  controlsListElement.innerHTML = '';
  mockGamepad = undefined;
}

function build(motionController) {
  clear$1();

  mockGamepad = motionController.xrInputSource.gamepad;

  Object.values(motionController.components).forEach((component) => {
    const { button, xAxis, yAxis } = component.description.gamepadIndices;

    let innerHtml = `
      <h4>Component ${component.id}</h4>
    `;

    if (button !== undefined) {
      innerHtml += `
      <label>buttonValue<label>
      <input id="buttonValue${button}" data-index="${button}" type="range" min="0" max="1" step="0.01" value="0">
      
      <label>touched</label>
      <input id="buttonTouched${button}" data-index="${button}" type="checkbox">

      <label>pressed</label>
      <input id="buttonPressed${button}" data-index="${button}" type="checkbox">
      `;
    }

    if (xAxis !== undefined) {
      innerHtml += `
      <br/>
      <label>xAxis<label>
      <input id="axis${xAxis}" data-index="${xAxis}"
             type="range" min="-1" max="1" step="0.01" value="0">
      `;
    }

    if (yAxis !== undefined) {
      innerHtml += `
        <label>yAxis<label>
        <input id="axis${yAxis}" data-index="${yAxis}"
              type="range" min="-1" max="1" step="0.01" value="0">
      `;
    }

    const listElement = document.createElement('li');
    listElement.setAttribute('class', 'component');
    listElement.innerHTML = innerHtml;
    controlsListElement.appendChild(listElement);

    if (button !== undefined) {
      document.getElementById(`buttonValue${button}`).addEventListener('input', onButtonValueChange);
      document.getElementById(`buttonTouched${button}`).addEventListener('click', onButtonTouched);
      document.getElementById(`buttonPressed${button}`).addEventListener('click', onButtonPressed);
    }

    if (xAxis !== undefined) {
      document.getElementById(`axis${xAxis}`).addEventListener('input', onAxisValueChange);
    }

    if (yAxis !== undefined) {
      document.getElementById(`axis${yAxis}`).addEventListener('input', onAxisValueChange);
    }
  });
}

var ManualControls = { clear: clear$1, build };

const selectorIdStorageKey = 'selectorId';
const selectors = {};
let activeSelector;

/**
 * Updates the controls and model viewer when the selected motion controller changes
 * @param {Object} event
 */
function onMotionControllerChange(event) {
  if (event.target === activeSelector.element) {
    ErrorLogging.clearAll();
    if (!event.detail) {
      ModelViewer.clear();
      ManualControls.clear();
    } else {
      const motionController = event.detail;
      ManualControls.build(motionController);
      ModelViewer.loadModel(motionController);
    }
  }
}

/**
 * Handles the selection source radio button change
 */
function onRadioChange() {
  ManualControls.clear();
  ModelViewer.clear();

  // Figure out which item is now selected
  const selectedQuery = 'input[name = "sourceSelector"]:checked';
  const selectorType = document.querySelector(selectedQuery).value;

  // Disable the previous selection source
  if (activeSelector) {
    activeSelector.disable();
  }

  // Start using the new selection source
  activeSelector = selectors[selectorType];
  activeSelector.enable();
  window.localStorage.setItem(selectorIdStorageKey, selectorType);
}

function onLoad() {
  ModelViewer.initialize();

  // Hook up event listeners to the radio buttons
  const repositoryRadioButton = document.getElementById('repositoryRadioButton');
  const localProfileRadioButton = document.getElementById('localProfileRadioButton');
  repositoryRadioButton.addEventListener('change', onRadioChange);
  localProfileRadioButton.addEventListener('change', onRadioChange);

  // Check if the page has stored a choice of selection source
  const storedSelectorId = window.localStorage.getItem(selectorIdStorageKey);
  const radioButtonToSelect = document.querySelector(`input[value = "${storedSelectorId}"]`);
  if (radioButtonToSelect) {
    radioButtonToSelect.checked = true;
  }

  // Create the objects to select motion controllers based on user input
  selectors.repository = new RepositorySelector();
  selectors.localProfile = new LocalProfileSelector();
  Object.values(selectors).forEach((selector) => {
    selector.element.addEventListener('motionControllerChange', onMotionControllerChange);
  });

  // manually trigger first check
  onRadioChange();
}
window.addEventListener('load', onLoad);
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VzIjpbIi4uL3NyYy9tb2Nrcy9tb2NrR2FtZXBhZC5qcyIsIi4uL3NyYy9tb2Nrcy9tb2NrWFJJbnB1dFNvdXJjZS5qcyIsIi4uL3NyYy9lcnJvckxvZ2dpbmcuanMiLCIuLi9zcmMvaGFuZGVkbmVzc1NlbGVjdG9yLmpzIiwiLi4vc3JjL3JlcG9zaXRvcnlTZWxlY3Rvci5qcyIsIi4uL3NyYy9sb2NhbFByb2ZpbGVTZWxlY3Rvci5qcyIsIi4uL3NyYy9tb2RlbFZpZXdlci5qcyIsIi4uL3NyYy9tYW51YWxDb250cm9scy5qcyIsIi4uL3NyYy9pbmRleC5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEEgZmFsc2UgZ2FtZXBhZCB0byBiZSB1c2VkIGluIHRlc3RzXG4gKi9cbmNsYXNzIE1vY2tHYW1lcGFkIHtcbiAgLyoqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBwcm9maWxlRGVzY3JpcHRpb24gLSBUaGUgcHJvZmlsZSBkZXNjcmlwdGlvbiB0byBwYXJzZSB0byBkZXRlcm1pbmUgdGhlIGxlbmd0aFxuICAgKiBvZiB0aGUgYnV0dG9uIGFuZCBheGVzIGFycmF5c1xuICAgKiBAcGFyYW0ge3N0cmluZ30gaGFuZGVkbmVzcyAtIFRoZSBnYW1lcGFkJ3MgaGFuZGVkbmVzc1xuICAgKi9cbiAgY29uc3RydWN0b3IocHJvZmlsZURlc2NyaXB0aW9uLCBoYW5kZWRuZXNzKSB7XG4gICAgaWYgKCFwcm9maWxlRGVzY3JpcHRpb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gcHJvZmlsZURlc2NyaXB0aW9uIHN1cHBsaWVkJyk7XG4gICAgfVxuXG4gICAgaWYgKCFoYW5kZWRuZXNzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vIGhhbmRlZG5lc3Mgc3VwcGxpZWQnKTtcbiAgICB9XG5cbiAgICB0aGlzLmlkID0gcHJvZmlsZURlc2NyaXB0aW9uLnByb2ZpbGVJZDtcblxuICAgIC8vIExvb3AgdGhyb3VnaCB0aGUgcHJvZmlsZSBkZXNjcmlwdGlvbiB0byBkZXRlcm1pbmUgaG93IG1hbnkgZWxlbWVudHMgdG8gcHV0IGluIHRoZSBidXR0b25zXG4gICAgLy8gYW5kIGF4ZXMgYXJyYXlzXG4gICAgbGV0IG1heEJ1dHRvbkluZGV4ID0gMDtcbiAgICBsZXQgbWF4QXhpc0luZGV4ID0gMDtcbiAgICBjb25zdCBsYXlvdXQgPSBwcm9maWxlRGVzY3JpcHRpb24ubGF5b3V0c1toYW5kZWRuZXNzXTtcbiAgICB0aGlzLm1hcHBpbmcgPSBsYXlvdXQubWFwcGluZztcbiAgICBPYmplY3QudmFsdWVzKGxheW91dC5jb21wb25lbnRzKS5mb3JFYWNoKCh7IGdhbWVwYWRJbmRpY2VzIH0pID0+IHtcbiAgICAgIGlmIChnYW1lcGFkSW5kaWNlcy5idXR0b24gIT09IHVuZGVmaW5lZCAmJiBnYW1lcGFkSW5kaWNlcy5idXR0b24gPiBtYXhCdXR0b25JbmRleCkge1xuICAgICAgICBtYXhCdXR0b25JbmRleCA9IGdhbWVwYWRJbmRpY2VzLmJ1dHRvbjtcbiAgICAgIH1cblxuICAgICAgaWYgKGdhbWVwYWRJbmRpY2VzLnhBeGlzICE9PSB1bmRlZmluZWQgJiYgKGdhbWVwYWRJbmRpY2VzLnhBeGlzID4gbWF4QXhpc0luZGV4KSkge1xuICAgICAgICBtYXhBeGlzSW5kZXggPSBnYW1lcGFkSW5kaWNlcy54QXhpcztcbiAgICAgIH1cblxuICAgICAgaWYgKGdhbWVwYWRJbmRpY2VzLnlBeGlzICE9PSB1bmRlZmluZWQgJiYgKGdhbWVwYWRJbmRpY2VzLnlBeGlzID4gbWF4QXhpc0luZGV4KSkge1xuICAgICAgICBtYXhBeGlzSW5kZXggPSBnYW1lcGFkSW5kaWNlcy55QXhpcztcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIEZpbGwgdGhlIGF4ZXMgYXJyYXlcbiAgICB0aGlzLmF4ZXMgPSBbXTtcbiAgICB3aGlsZSAodGhpcy5heGVzLmxlbmd0aCA8PSBtYXhBeGlzSW5kZXgpIHtcbiAgICAgIHRoaXMuYXhlcy5wdXNoKDApO1xuICAgIH1cblxuICAgIC8vIEZpbGwgdGhlIGJ1dHRvbnMgYXJyYXlcbiAgICB0aGlzLmJ1dHRvbnMgPSBbXTtcbiAgICB3aGlsZSAodGhpcy5idXR0b25zLmxlbmd0aCA8PSBtYXhCdXR0b25JbmRleCkge1xuICAgICAgdGhpcy5idXR0b25zLnB1c2goe1xuICAgICAgICB2YWx1ZTogMCxcbiAgICAgICAgdG91Y2hlZDogZmFsc2UsXG4gICAgICAgIHByZXNzZWQ6IGZhbHNlXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgTW9ja0dhbWVwYWQ7XG4iLCIvKipcbiAqIEEgZmFrZSBYUklucHV0U291cmNlIHRoYXQgY2FuIGJlIHVzZWQgdG8gaW5pdGlhbGl6ZSBhIE1vdGlvbkNvbnRyb2xsZXJcbiAqL1xuY2xhc3MgTW9ja1hSSW5wdXRTb3VyY2Uge1xuICAvKipcbiAgICogQHBhcmFtIHtPYmplY3R9IGdhbWVwYWQgLSBUaGUgR2FtZXBhZCBvYmplY3QgdGhhdCBwcm92aWRlcyB0aGUgYnV0dG9uIGFuZCBheGlzIGRhdGFcbiAgICogQHBhcmFtIHtzdHJpbmd9IGhhbmRlZG5lc3MgLSBUaGUgaGFuZGVkbmVzcyB0byByZXBvcnRcbiAgICovXG4gIGNvbnN0cnVjdG9yKGdhbWVwYWQsIGhhbmRlZG5lc3MpIHtcbiAgICB0aGlzLmdhbWVwYWQgPSBnYW1lcGFkO1xuXG4gICAgaWYgKCFoYW5kZWRuZXNzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vIGhhbmRlZG5lc3Mgc3VwcGxpZWQnKTtcbiAgICB9XG5cbiAgICB0aGlzLmhhbmRlZG5lc3MgPSBoYW5kZWRuZXNzO1xuICAgIHRoaXMucHJvZmlsZXMgPSBPYmplY3QuZnJlZXplKFt0aGlzLmdhbWVwYWQuaWRdKTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBNb2NrWFJJbnB1dFNvdXJjZTtcbiIsImNvbnN0IGVycm9yc0VsZW1lbnRJZCA9ICdlcnJvcnMnO1xubGV0IGxpc3RFbGVtZW50O1xuXG5mdW5jdGlvbiB0b2dnbGVWaXNpYmlsaXR5KCkge1xuICBjb25zdCBlcnJvcnNFbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoZXJyb3JzRWxlbWVudElkKTtcbiAgZXJyb3JzRWxlbWVudC5oaWRkZW4gPSBlcnJvcnNFbGVtZW50LmNoaWxkcmVuLmxlbmd0aCA9PT0gMDtcbn1cblxuZnVuY3Rpb24gYWRkRXJyb3JFbGVtZW50KGVycm9yTWVzc2FnZSkge1xuICBjb25zdCBlcnJvcnNFbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoZXJyb3JzRWxlbWVudElkKTtcbiAgaWYgKCFsaXN0RWxlbWVudCkge1xuICAgIGxpc3RFbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndWwnKTtcbiAgICBlcnJvcnNFbGVtZW50LmFwcGVuZENoaWxkKGxpc3RFbGVtZW50KTtcbiAgfVxuXG4gIGNvbnN0IGl0ZW1FbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGknKTtcbiAgaXRlbUVsZW1lbnQuaW5uZXJUZXh0ID0gZXJyb3JNZXNzYWdlO1xuICBsaXN0RWxlbWVudC5hcHBlbmRDaGlsZChpdGVtRWxlbWVudCk7XG5cbiAgdG9nZ2xlVmlzaWJpbGl0eSgpO1xufVxuXG5jb25zdCBFcnJvckxvZ2dpbmcgPSB7XG4gIGxvZzogKGVycm9yTWVzc2FnZSkgPT4ge1xuICAgIGFkZEVycm9yRWxlbWVudChlcnJvck1lc3NhZ2UpO1xuXG4gICAgLyogZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGUgKi9cbiAgICBjb25zb2xlLmVycm9yKGVycm9yTWVzc2FnZSk7XG4gIH0sXG5cbiAgdGhyb3c6IChlcnJvck1lc3NhZ2UpID0+IHtcbiAgICBhZGRFcnJvckVsZW1lbnQoZXJyb3JNZXNzYWdlKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoZXJyb3JNZXNzYWdlKTtcbiAgfSxcblxuICBjbGVhcjogKCkgPT4ge1xuICAgIGlmIChsaXN0RWxlbWVudCkge1xuICAgICAgY29uc3QgZXJyb3JzRWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGVycm9yc0VsZW1lbnRJZCk7XG4gICAgICBlcnJvcnNFbGVtZW50LnJlbW92ZUNoaWxkKGxpc3RFbGVtZW50KTtcbiAgICAgIGxpc3RFbGVtZW50ID0gdW5kZWZpbmVkO1xuICAgIH1cbiAgICB0b2dnbGVWaXNpYmlsaXR5KCk7XG4gIH0sXG5cbiAgY2xlYXJBbGw6ICgpID0+IHtcbiAgICBjb25zdCBlcnJvcnNFbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoZXJyb3JzRWxlbWVudElkKTtcbiAgICBlcnJvcnNFbGVtZW50LmlubmVySFRNTCA9ICcnO1xuICAgIGxpc3RFbGVtZW50ID0gdW5kZWZpbmVkO1xuICAgIHRvZ2dsZVZpc2liaWxpdHkoKTtcbiAgfVxufTtcblxuZXhwb3J0IGRlZmF1bHQgRXJyb3JMb2dnaW5nO1xuIiwiaW1wb3J0IEVycm9yTG9nZ2luZyBmcm9tICcuL2Vycm9yTG9nZ2luZy5qcyc7XG5cbi8qKlxuICogQWRkcyBhIHNlbGVjdG9yIGZvciBjaG9vc2luZyB0aGUgaGFuZGVkbmVzcyBvZiB0aGUgcHJvdmlkZWQgcHJvZmlsZVxuICovXG5jbGFzcyBIYW5kZWRuZXNzU2VsZWN0b3Ige1xuICBjb25zdHJ1Y3RvcihwYXJlbnRTZWxlY3RvclR5cGUpIHtcbiAgICB0aGlzLnNlbGVjdG9yVHlwZSA9IHBhcmVudFNlbGVjdG9yVHlwZTtcblxuICAgIC8vIENyZWF0ZSB0aGUgaGFuZGVkbmVzcyBzZWxlY3RvciBhbmQgd2F0Y2ggZm9yIGNoYW5nZXNcbiAgICB0aGlzLmVsZW1lbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTtcbiAgICB0aGlzLmVsZW1lbnQuaWQgPSBgJHt0aGlzLnNlbGVjdG9yVHlwZX1IYW5kZWRuZXNzU2VsZWN0b3JgO1xuICAgIHRoaXMuZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7IHRoaXMub25IYW5kZWRuZXNzU2VsZWN0ZWQoKTsgfSk7XG5cbiAgICB0aGlzLmNsZWFyU2VsZWN0ZWRQcm9maWxlKCk7XG4gIH1cblxuICAvKipcbiAgICogRmlyZXMgYW4gZXZlbnQgbm90aWZ5aW5nIHRoYXQgdGhlIGhhbmRlZG5lc3MgaGFzIGNoYW5nZWRcbiAgICovXG4gIGZpcmVIYW5kZWRuZXNzQ2hhbmdlKCkge1xuICAgIGNvbnN0IGNoYW5nZUV2ZW50ID0gbmV3IEN1c3RvbUV2ZW50KCdoYW5kZWRuZXNzQ2hhbmdlJywgeyBkZXRhaWw6IHRoaXMuaGFuZGVkbmVzcyB9KTtcbiAgICB0aGlzLmVsZW1lbnQuZGlzcGF0Y2hFdmVudChjaGFuZ2VFdmVudCk7XG4gIH1cblxuICBjbGVhclNlbGVjdGVkUHJvZmlsZSgpIHtcbiAgICB0aGlzLnNlbGVjdGVkUHJvZmlsZSA9IG51bGw7XG4gICAgdGhpcy5oYW5kZWRuZXNzU3RvcmFnZUtleSA9IG51bGw7XG4gICAgdGhpcy5lbGVtZW50LmRpc2FibGVkID0gdHJ1ZTtcbiAgICB0aGlzLmVsZW1lbnQuaW5uZXJIVE1MID0gJzxvcHRpb24gdmFsdWU9XCJsb2FkaW5nXCI+TG9hZGluZy4uLjwvb3B0aW9uPic7XG4gICAgdGhpcy5maXJlSGFuZGVkbmVzc0NoYW5nZShudWxsKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25kcyB0byBjaGFuZ2VzIGluIHRoZSBkcm9wZG93biwgc2F2ZXMgdGhlIHZhbHVlIHRvIGxvY2FsIHN0b3JhZ2UsIGFuZCB0cmlnZ2VycyB0aGUgZXZlbnRcbiAgICovXG4gIG9uSGFuZGVkbmVzc1NlbGVjdGVkKCkge1xuICAgIC8vIENyZWF0ZSBhIG1vY2sgZ2FtZXBhZCB0aGF0IG1hdGNoZXMgdGhlIHByb2ZpbGUgYW5kIGhhbmRlZG5lc3NcbiAgICB0aGlzLmhhbmRlZG5lc3MgPSB0aGlzLmVsZW1lbnQudmFsdWU7XG4gICAgd2luZG93LmxvY2FsU3RvcmFnZS5zZXRJdGVtKHRoaXMuaGFuZGVkbmVzc1N0b3JhZ2VLZXksIHRoaXMuaGFuZGVkbmVzcyk7XG4gICAgdGhpcy5maXJlSGFuZGVkbmVzc0NoYW5nZSgpO1xuICB9XG5cbiAgLyoqXG4gICAqIFNldHMgdGhlIHByb2ZpbGUgZnJvbSB3aGljaCBoYW5kZWRuZXNzIG5lZWRzIHRvIGJlIHNlbGVjdGVkXG4gICAqIEBwYXJhbSB7b2JqZWN0fSBwcm9maWxlXG4gICAqL1xuICBzZXRTZWxlY3RlZFByb2ZpbGUocHJvZmlsZSkge1xuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcbiAgICB0aGlzLnNlbGVjdGVkUHJvZmlsZSA9IHByb2ZpbGU7XG5cbiAgICAvLyBMb2FkIGFuZCBjbGVhciB0aGUgbGFzdCBzZWxlY3Rpb24gZm9yIHRoaXMgcHJvZmlsZSBpZFxuICAgIHRoaXMuaGFuZGVkbmVzc1N0b3JhZ2VLZXkgPSBgJHt0aGlzLnNlbGVjdG9yVHlwZX1fJHt0aGlzLnNlbGVjdGVkUHJvZmlsZS5pZH1faGFuZGVkbmVzc2A7XG4gICAgY29uc3Qgc3RvcmVkSGFuZGVkbmVzcyA9IHdpbmRvdy5sb2NhbFN0b3JhZ2UuZ2V0SXRlbSh0aGlzLmhhbmRlZG5lc3NTdG9yYWdlS2V5KTtcbiAgICB3aW5kb3cubG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0odGhpcy5oYW5kZWRuZXNzU3RvcmFnZUtleSk7XG5cbiAgICAvLyBQb3B1bGF0ZSBoYW5kZWRuZXNzIHNlbGVjdG9yXG4gICAgdGhpcy5lbGVtZW50LmlubmVySFRNTCA9ICcnO1xuICAgIE9iamVjdC5rZXlzKHRoaXMuc2VsZWN0ZWRQcm9maWxlLmxheW91dHMpLmZvckVhY2goKGhhbmRlZG5lc3MpID0+IHtcbiAgICAgIHRoaXMuZWxlbWVudC5pbm5lckhUTUwgKz0gYFxuICAgICAgICA8b3B0aW9uIHZhbHVlPScke2hhbmRlZG5lc3N9Jz4ke2hhbmRlZG5lc3N9PC9vcHRpb24+XG4gICAgICBgO1xuICAgIH0pO1xuXG4gICAgaWYgKHRoaXMuZWxlbWVudC5jaGlsZHJlbi5sZW5ndGggPT09IDApIHtcbiAgICAgIEVycm9yTG9nZ2luZy5sb2coYE5vIGhhbmRlZG5lc3MgdmFsdWVzIGZvdW5kIGZvciBwcm9maWxlICR7dGhpcy5zZWxlY3RlZFByb2ZpbGUuaWR9YCk7XG4gICAgfVxuXG4gICAgLy8gQXBwbHkgc3RvcmVkIGhhbmRlZG5lc3MgaWYgZm91bmRcbiAgICBpZiAoc3RvcmVkSGFuZGVkbmVzcyAmJiB0aGlzLnNlbGVjdGVkUHJvZmlsZS5sYXlvdXRzW3N0b3JlZEhhbmRlZG5lc3NdKSB7XG4gICAgICB0aGlzLmVsZW1lbnQudmFsdWUgPSBzdG9yZWRIYW5kZWRuZXNzO1xuICAgIH1cblxuICAgIC8vIE1hbnVhbGx5IHRyaWdnZXIgdGhlIGhhbmRlZG5lc3MgdG8gY2hhbmdlXG4gICAgdGhpcy5lbGVtZW50LmRpc2FibGVkID0gZmFsc2U7XG4gICAgdGhpcy5vbkhhbmRlZG5lc3NTZWxlY3RlZCgpO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IEhhbmRlZG5lc3NTZWxlY3RvcjtcbiIsIi8qIGVzbGludC1kaXNhYmxlIGltcG9ydC9uby11bnJlc29sdmVkICovXG5pbXBvcnQgeyBmZXRjaFByb2ZpbGUsIGZldGNoUHJvZmlsZXNMaXN0LCBNb3Rpb25Db250cm9sbGVyIH0gZnJvbSAnLi9tb3Rpb24tY29udHJvbGxlcnMubW9kdWxlLmpzJztcbi8qIGVzbGludC1lbmFibGUgKi9cblxuaW1wb3J0IE1vY2tHYW1lcGFkIGZyb20gJy4vbW9ja3MvbW9ja0dhbWVwYWQuanMnO1xuaW1wb3J0IE1vY2tYUklucHV0U291cmNlIGZyb20gJy4vbW9ja3MvbW9ja1hSSW5wdXRTb3VyY2UuanMnO1xuXG5pbXBvcnQgRXJyb3JMb2dnaW5nIGZyb20gJy4vZXJyb3JMb2dnaW5nLmpzJztcbmltcG9ydCBIYW5kZWRuZXNzU2VsZWN0b3IgZnJvbSAnLi9oYW5kZWRuZXNzU2VsZWN0b3IuanMnO1xuXG5jb25zdCBwcm9maWxlSWRTdG9yYWdlS2V5ID0gJ3JlcG9zaXRvcnlfcHJvZmlsZUlkJztcbmNvbnN0IHByb2ZpbGVzQmFzZVBhdGggPSAnLi9wcm9maWxlcyc7XG4vKipcbiAqIExvYWRzIHByb2ZpbGVzIGZyb20gdGhlIGRpc3RyaWJ1dGlvbiBmb2xkZXIgbmV4dCB0byB0aGUgdmlld2VyJ3MgbG9jYXRpb25cbiAqL1xuY2xhc3MgUmVwb3NpdG9yeVNlbGVjdG9yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgdGhpcy5lbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlcG9zaXRvcnknKTtcblxuICAgIC8vIEdldCB0aGUgcHJvZmlsZSBpZCBkcm9wZG93biBhbmQgbGlzdGVuIGZvciBjaGFuZ2VzXG4gICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVwb3NpdG9yeVByb2ZpbGVJZFNlbGVjdG9yJyk7XG4gICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4geyB0aGlzLm9uUHJvZmlsZUlkU2VsZWN0ZWQoKTsgfSk7XG5cbiAgICAvLyBBZGQgYSBoYW5kZWRuZXNzIHNlbGVjdG9yIGFuZCBsaXN0ZW4gZm9yIGNoYW5nZXNcbiAgICB0aGlzLmhhbmRlZG5lc3NTZWxlY3RvciA9IG5ldyBIYW5kZWRuZXNzU2VsZWN0b3IoJ3JlcG9zaXRvcnknKTtcbiAgICB0aGlzLmVsZW1lbnQuYXBwZW5kQ2hpbGQodGhpcy5oYW5kZWRuZXNzU2VsZWN0b3IuZWxlbWVudCk7XG4gICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3IuZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdoYW5kZWRuZXNzQ2hhbmdlJywgKGV2ZW50KSA9PiB7IHRoaXMub25IYW5kZWRuZXNzQ2hhbmdlKGV2ZW50KTsgfSk7XG5cbiAgICB0aGlzLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB0aGlzLmNsZWFyU2VsZWN0ZWRQcm9maWxlKCk7XG4gIH1cblxuICBlbmFibGUoKSB7XG4gICAgdGhpcy5lbGVtZW50LmhpZGRlbiA9IGZhbHNlO1xuICAgIHRoaXMuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB0aGlzLnBvcHVsYXRlUHJvZmlsZVNlbGVjdG9yKCk7XG4gIH1cblxuICBkaXNhYmxlKCkge1xuICAgIHRoaXMuZWxlbWVudC5oaWRkZW4gPSB0cnVlO1xuICAgIHRoaXMuZGlzYWJsZWQgPSB0cnVlO1xuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcbiAgfVxuXG4gIGNsZWFyU2VsZWN0ZWRQcm9maWxlKCkge1xuICAgIEVycm9yTG9nZ2luZy5jbGVhckFsbCgpO1xuICAgIHRoaXMuc2VsZWN0ZWRQcm9maWxlID0gbnVsbDtcbiAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC5kaXNhYmxlZCA9IHRydWU7XG4gICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3IuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25kcyB0byBjaGFuZ2VzIGluIHNlbGVjdGVkIGhhbmRlZG5lc3MuXG4gICAqIENyZWF0ZXMgYSBuZXcgbW90aW9uIGNvbnRyb2xsZXIgZm9yIHRoZSBjb21iaW5hdGlvbiBvZiBwcm9maWxlIGFuZCBoYW5kZWRuZXNzLCBhbmQgZmlyZXMgYW5cbiAgICogZXZlbnQgdG8gc2lnbmFsIHRoZSBjaGFuZ2VcbiAgICogQHBhcmFtIHtvYmplY3R9IGV2ZW50XG4gICAqL1xuICBvbkhhbmRlZG5lc3NDaGFuZ2UoZXZlbnQpIHtcbiAgICBpZiAoIXRoaXMuZGlzYWJsZWQpIHtcbiAgICAgIGxldCBtb3Rpb25Db250cm9sbGVyO1xuICAgICAgY29uc3QgaGFuZGVkbmVzcyA9IGV2ZW50LmRldGFpbDtcblxuICAgICAgLy8gQ3JlYXRlIG1vdGlvbiBjb250cm9sbGVyIGlmIGEgaGFuZGVkbmVzcyBoYXMgYmVlbiBzZWxlY3RlZFxuICAgICAgaWYgKGhhbmRlZG5lc3MpIHtcbiAgICAgICAgY29uc3QgbW9ja0dhbWVwYWQgPSBuZXcgTW9ja0dhbWVwYWQodGhpcy5zZWxlY3RlZFByb2ZpbGUsIGhhbmRlZG5lc3MpO1xuICAgICAgICBjb25zdCBtb2NrWFJJbnB1dFNvdXJjZSA9IG5ldyBNb2NrWFJJbnB1dFNvdXJjZShtb2NrR2FtZXBhZCwgaGFuZGVkbmVzcyk7XG5cbiAgICAgICAgZmV0Y2hQcm9maWxlKG1vY2tYUklucHV0U291cmNlLCBwcm9maWxlc0Jhc2VQYXRoKS50aGVuKCh7IHByb2ZpbGUsIGFzc2V0UGF0aCB9KSA9PiB7XG4gICAgICAgICAgbW90aW9uQ29udHJvbGxlciA9IG5ldyBNb3Rpb25Db250cm9sbGVyKFxuICAgICAgICAgICAgbW9ja1hSSW5wdXRTb3VyY2UsXG4gICAgICAgICAgICBwcm9maWxlLFxuICAgICAgICAgICAgYXNzZXRQYXRoXG4gICAgICAgICAgKTtcblxuICAgICAgICAgIC8vIFNpZ25hbCB0aGUgY2hhbmdlXG4gICAgICAgICAgY29uc3QgY2hhbmdlRXZlbnQgPSBuZXcgQ3VzdG9tRXZlbnQoXG4gICAgICAgICAgICAnbW90aW9uQ29udHJvbGxlckNoYW5nZScsXG4gICAgICAgICAgICB7IGRldGFpbDogbW90aW9uQ29udHJvbGxlciB9XG4gICAgICAgICAgKTtcbiAgICAgICAgICB0aGlzLmVsZW1lbnQuZGlzcGF0Y2hFdmVudChjaGFuZ2VFdmVudCk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gU2lnbmFsIHRoZSBjaGFuZ2VcbiAgICAgICAgY29uc3QgY2hhbmdlRXZlbnQgPSBuZXcgQ3VzdG9tRXZlbnQoJ21vdGlvbkNvbnRyb2xsZXJDaGFuZ2UnLCB7IGRldGFpbDogbnVsbCB9KTtcbiAgICAgICAgdGhpcy5lbGVtZW50LmRpc3BhdGNoRXZlbnQoY2hhbmdlRXZlbnQpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBIYW5kbGVyIGZvciB0aGUgcHJvZmlsZSBpZCBzZWxlY3Rpb24gY2hhbmdlXG4gICAqL1xuICBvblByb2ZpbGVJZFNlbGVjdGVkKCkge1xuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcblxuICAgIGNvbnN0IHByb2ZpbGVJZCA9IHRoaXMucHJvZmlsZUlkU2VsZWN0b3JFbGVtZW50LnZhbHVlO1xuICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2Uuc2V0SXRlbShwcm9maWxlSWRTdG9yYWdlS2V5LCBwcm9maWxlSWQpO1xuXG4gICAgLy8gQXR0ZW1wdCB0byBsb2FkIHRoZSBwcm9maWxlXG4gICAgZmV0Y2hQcm9maWxlKHsgcHJvZmlsZXM6IFtwcm9maWxlSWRdIH0sIHByb2ZpbGVzQmFzZVBhdGgsIGZhbHNlKS50aGVuKCh7IHByb2ZpbGUgfSkgPT4ge1xuICAgICAgdGhpcy5zZWxlY3RlZFByb2ZpbGUgPSBwcm9maWxlO1xuICAgICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3Iuc2V0U2VsZWN0ZWRQcm9maWxlKHRoaXMuc2VsZWN0ZWRQcm9maWxlKTtcbiAgICB9KVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBFcnJvckxvZ2dpbmcubG9nKGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIHRoaXMucHJvZmlsZUlkU2VsZWN0b3JFbGVtZW50LmRpc2FibGVkID0gZmFsc2U7XG4gICAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXRyaWV2ZXMgdGhlIGZ1bGwgbGlzdCBvZiBhdmFpbGFibGUgcHJvZmlsZXNcbiAgICovXG4gIHBvcHVsYXRlUHJvZmlsZVNlbGVjdG9yKCkge1xuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcblxuICAgIC8vIExvYWQgYW5kIGNsZWFyIGxvY2FsIHN0b3JhZ2VcbiAgICBjb25zdCBzdG9yZWRQcm9maWxlSWQgPSB3aW5kb3cubG9jYWxTdG9yYWdlLmdldEl0ZW0ocHJvZmlsZUlkU3RvcmFnZUtleSk7XG4gICAgd2luZG93LmxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKHByb2ZpbGVJZFN0b3JhZ2VLZXkpO1xuXG4gICAgLy8gTG9hZCB0aGUgbGlzdCBvZiBwcm9maWxlc1xuICAgIHRoaXMucHJvZmlsZUlkU2VsZWN0b3JFbGVtZW50LmlubmVySFRNTCA9ICc8b3B0aW9uIHZhbHVlPVwibG9hZGluZ1wiPkxvYWRpbmcuLi48L29wdGlvbj4nO1xuICAgIGZldGNoUHJvZmlsZXNMaXN0KHByb2ZpbGVzQmFzZVBhdGgpLnRoZW4oKHByb2ZpbGVzTGlzdCkgPT4ge1xuICAgICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQuaW5uZXJIVE1MID0gJyc7XG4gICAgICBPYmplY3Qua2V5cyhwcm9maWxlc0xpc3QpLmZvckVhY2goKHByb2ZpbGVJZCkgPT4ge1xuICAgICAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC5pbm5lckhUTUwgKz0gYFxuICAgICAgICA8b3B0aW9uIHZhbHVlPScke3Byb2ZpbGVJZH0nPiR7cHJvZmlsZUlkfTwvb3B0aW9uPlxuICAgICAgICBgO1xuICAgICAgfSk7XG5cbiAgICAgIC8vIE92ZXJyaWRlIHRoZSBkZWZhdWx0IHNlbGVjdGlvbiBpZiB2YWx1ZXMgd2VyZSBwcmVzZW50IGluIGxvY2FsIHN0b3JhZ2VcbiAgICAgIGlmIChzdG9yZWRQcm9maWxlSWQpIHtcbiAgICAgICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQudmFsdWUgPSBzdG9yZWRQcm9maWxlSWQ7XG4gICAgICB9XG5cbiAgICAgIC8vIE1hbnVhbGx5IHRyaWdnZXIgc2VsZWN0ZWQgcHJvZmlsZSB0byBsb2FkXG4gICAgICB0aGlzLm9uUHJvZmlsZUlkU2VsZWN0ZWQoKTtcbiAgICB9KVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBFcnJvckxvZ2dpbmcubG9nKGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IFJlcG9zaXRvcnlTZWxlY3RvcjtcbiIsIi8qIGVzbGludC1kaXNhYmxlIGltcG9ydC9uby11bnJlc29sdmVkICovXG5pbXBvcnQgeyBNb3Rpb25Db250cm9sbGVyIH0gZnJvbSAnLi9tb3Rpb24tY29udHJvbGxlcnMubW9kdWxlLmpzJztcbmltcG9ydCAnLi9hanYvYWp2Lm1pbi5qcyc7XG5pbXBvcnQgbWVyZ2VQcm9maWxlIGZyb20gJy4vcHJvZmlsZXNUb29scy9tZXJnZVByb2ZpbGUuanMnO1xuLyogZXNsaW50LWVuYWJsZSAqL1xuXG5pbXBvcnQgTW9ja0dhbWVwYWQgZnJvbSAnLi9tb2Nrcy9tb2NrR2FtZXBhZC5qcyc7XG5pbXBvcnQgTW9ja1hSSW5wdXRTb3VyY2UgZnJvbSAnLi9tb2Nrcy9tb2NrWFJJbnB1dFNvdXJjZS5qcyc7XG5pbXBvcnQgRXJyb3JMb2dnaW5nIGZyb20gJy4vZXJyb3JMb2dnaW5nLmpzJztcbmltcG9ydCBIYW5kZWRuZXNzU2VsZWN0b3IgZnJvbSAnLi9oYW5kZWRuZXNzU2VsZWN0b3IuanMnO1xuXG4vKipcbiAqIExvYWRzIHNlbGVjdGVkIGZpbGUgZnJvbSBmaWxlc3lzdGVtIGFuZCBzZXRzIGl0IGFzIHRoZSBzZWxlY3RlZCBwcm9maWxlXG4gKiBAcGFyYW0ge09iamVjdH0ganNvbkZpbGVcbiAqL1xuZnVuY3Rpb24gbG9hZExvY2FsSnNvbihqc29uRmlsZSkge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHJlYWRlciA9IG5ldyBGaWxlUmVhZGVyKCk7XG5cbiAgICByZWFkZXIub25sb2FkID0gKCkgPT4ge1xuICAgICAgY29uc3QganNvbiA9IEpTT04ucGFyc2UocmVhZGVyLnJlc3VsdCk7XG4gICAgICByZXNvbHZlKGpzb24pO1xuICAgIH07XG5cbiAgICByZWFkZXIub25lcnJvciA9ICgpID0+IHtcbiAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGBVbmFibGUgdG8gbG9hZCBKU09OIGZyb20gJHtqc29uRmlsZS5uYW1lfWA7XG4gICAgICBFcnJvckxvZ2dpbmcubG9nRXJyb3IoZXJyb3JNZXNzYWdlKTtcbiAgICAgIHJlamVjdChlcnJvck1lc3NhZ2UpO1xuICAgIH07XG5cbiAgICByZWFkZXIucmVhZEFzVGV4dChqc29uRmlsZSk7XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBidWlsZFNjaGVtYVZhbGlkYXRvcigpIHtcbiAgY29uc3Qgc2NoZW1hc1BhdGggPSAncHJvZmlsZXNUb29scy9zY2hlbWFzLmpzb24nO1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKHNjaGVtYXNQYXRoKTtcbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIEVycm9yTG9nZ2luZy50aHJvdyhyZXNwb25zZS5zdGF0dXNUZXh0KTtcbiAgfVxuXG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby11bmRlZlxuICBjb25zdCBhanYgPSBuZXcgQWp2KCk7XG4gIGNvbnN0IHNjaGVtYXMgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gIHNjaGVtYXMuZGVwZW5kZW5jaWVzLmZvckVhY2goKHNjaGVtYSkgPT4ge1xuICAgIGFqdi5hZGRTY2hlbWEoc2NoZW1hKTtcbiAgfSk7XG5cbiAgcmV0dXJuIGFqdi5jb21waWxlKHNjaGVtYXMubWFpblNjaGVtYSk7XG59XG5cbi8qKlxuICogTG9hZHMgYSBwcm9maWxlIGZyb20gYSBzZXQgb2YgbG9jYWwgZmlsZXNcbiAqL1xuY2xhc3MgTG9jYWxQcm9maWxlU2VsZWN0b3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICB0aGlzLmVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9jYWxQcm9maWxlJyk7XG4gICAgdGhpcy5sb2NhbEZpbGVzTGlzdEVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9jYWxGaWxlc0xpc3QnKTtcblxuICAgIC8vIEdldCB0aGUgYXNzZXRzIHNlbGVjdG9yIGFuZCB3YXRjaCBmb3IgY2hhbmdlc1xuICAgIHRoaXMucmVnaXN0cnlKc29uU2VsZWN0b3IgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9jYWxQcm9maWxlUmVnaXN0cnlKc29uU2VsZWN0b3InKTtcbiAgICB0aGlzLnJlZ2lzdHJ5SnNvblNlbGVjdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHsgdGhpcy5vblJlZ2lzdHJ5SnNvblNlbGVjdGVkKCk7IH0pO1xuXG4gICAgLy8gR2V0IHRoZSBhc3NldCBqc29uICBzZWxlY3RvciBhbmQgd2F0Y2ggZm9yIGNoYW5nZXNcbiAgICB0aGlzLmFzc2V0SnNvblNlbGVjdG9yID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvY2FsUHJvZmlsZUFzc2V0SnNvblNlbGVjdG9yJyk7XG4gICAgdGhpcy5hc3NldEpzb25TZWxlY3Rvci5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7IHRoaXMub25Bc3NldEpzb25TZWxlY3RlZCgpOyB9KTtcblxuICAgIC8vIEdldCB0aGUgcmVnaXN0cnkganNvbiBzZWxlY3RvciBhbmQgd2F0Y2ggZm9yIGNoYW5nZXNcbiAgICB0aGlzLmFzc2V0c1NlbGVjdG9yID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvY2FsUHJvZmlsZUFzc2V0c1NlbGVjdG9yJyk7XG4gICAgdGhpcy5hc3NldHNTZWxlY3Rvci5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7IHRoaXMub25Bc3NldHNTZWxlY3RlZCgpOyB9KTtcblxuICAgIC8vIEFkZCBhIGhhbmRlZG5lc3Mgc2VsZWN0b3IgYW5kIGxpc3RlbiBmb3IgY2hhbmdlc1xuICAgIHRoaXMuaGFuZGVkbmVzc1NlbGVjdG9yID0gbmV3IEhhbmRlZG5lc3NTZWxlY3RvcignbG9jYWxQcm9maWxlJyk7XG4gICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3IuZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdoYW5kZWRuZXNzQ2hhbmdlJywgKGV2ZW50KSA9PiB7IHRoaXMub25IYW5kZWRuZXNzQ2hhbmdlKGV2ZW50KTsgfSk7XG4gICAgdGhpcy5lbGVtZW50Lmluc2VydEJlZm9yZSh0aGlzLmhhbmRlZG5lc3NTZWxlY3Rvci5lbGVtZW50LCB0aGlzLmxvY2FsRmlsZXNMaXN0RWxlbWVudCk7XG5cbiAgICB0aGlzLmRpc2FibGVkID0gdHJ1ZTtcblxuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcblxuICAgIGJ1aWxkU2NoZW1hVmFsaWRhdG9yKCkudGhlbigoc2NoZW1hVmFsaWRhdG9yKSA9PiB7XG4gICAgICB0aGlzLnNjaGVtYVZhbGlkYXRvciA9IHNjaGVtYVZhbGlkYXRvcjtcbiAgICAgIC8vIFRPRE8gZmlndXJlIG91dCBkaXNhYmxlZCB0aGluZ1xuICAgICAgdGhpcy5vblJlZ2lzdHJ5SnNvblNlbGVjdGVkKCk7XG4gICAgICB0aGlzLm9uQXNzZXRKc29uU2VsZWN0ZWQoKTtcbiAgICAgIHRoaXMub25Bc3NldHNTZWxlY3RlZCgpO1xuICAgIH0pO1xuICB9XG5cbiAgZW5hYmxlKCkge1xuICAgIHRoaXMuZWxlbWVudC5oaWRkZW4gPSBmYWxzZTtcbiAgICB0aGlzLmRpc2FibGVkID0gZmFsc2U7XG4gIH1cblxuICBkaXNhYmxlKCkge1xuICAgIHRoaXMuZWxlbWVudC5oaWRkZW4gPSB0cnVlO1xuICAgIHRoaXMuZGlzYWJsZWQgPSB0cnVlO1xuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcbiAgfVxuXG4gIGNsZWFyU2VsZWN0ZWRQcm9maWxlKCkge1xuICAgIEVycm9yTG9nZ2luZy5jbGVhckFsbCgpO1xuICAgIHRoaXMucmVnaXN0cnlKc29uID0gbnVsbDtcbiAgICB0aGlzLmFzc2V0SnNvbiA9IG51bGw7XG4gICAgdGhpcy5tZXJnZWRQcm9maWxlID0gbnVsbDtcbiAgICB0aGlzLmFzc2V0cyA9IFtdO1xuICAgIHRoaXMuaGFuZGVkbmVzc1NlbGVjdG9yLmNsZWFyU2VsZWN0ZWRQcm9maWxlKCk7XG4gIH1cblxuICBjcmVhdGVNb3Rpb25Db250cm9sbGVyKCkge1xuICAgIGxldCBtb3Rpb25Db250cm9sbGVyO1xuICAgIGlmICh0aGlzLmhhbmRlZG5lc3NTZWxlY3Rvci5oYW5kZWRuZXNzICYmIHRoaXMubWVyZ2VkUHJvZmlsZSkge1xuICAgICAgY29uc3QgeyBoYW5kZWRuZXNzIH0gPSB0aGlzLmhhbmRlZG5lc3NTZWxlY3RvcjtcbiAgICAgIGNvbnN0IG1vY2tHYW1lcGFkID0gbmV3IE1vY2tHYW1lcGFkKHRoaXMubWVyZ2VkUHJvZmlsZSwgaGFuZGVkbmVzcyk7XG4gICAgICBjb25zdCBtb2NrWFJJbnB1dFNvdXJjZSA9IG5ldyBNb2NrWFJJbnB1dFNvdXJjZShtb2NrR2FtZXBhZCwgaGFuZGVkbmVzcyk7XG5cbiAgICAgIGNvbnN0IGFzc2V0TmFtZSA9IHRoaXMubWVyZ2VkUHJvZmlsZS5sYXlvdXRzW2hhbmRlZG5lc3NdLnBhdGg7XG4gICAgICBjb25zdCBhc3NldFVybCA9IHRoaXMuYXNzZXRzW2Fzc2V0TmFtZV07XG4gICAgICBtb3Rpb25Db250cm9sbGVyID0gbmV3IE1vdGlvbkNvbnRyb2xsZXIobW9ja1hSSW5wdXRTb3VyY2UsIHRoaXMubWVyZ2VkUHJvZmlsZSwgYXNzZXRVcmwpO1xuICAgIH1cblxuICAgIGNvbnN0IGNoYW5nZUV2ZW50ID0gbmV3IEN1c3RvbUV2ZW50KCdtb3Rpb25Db250cm9sbGVyQ2hhbmdlJywgeyBkZXRhaWw6IG1vdGlvbkNvbnRyb2xsZXIgfSk7XG4gICAgdGhpcy5lbGVtZW50LmRpc3BhdGNoRXZlbnQoY2hhbmdlRXZlbnQpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbmRzIHRvIGNoYW5nZXMgaW4gc2VsZWN0ZWQgaGFuZGVkbmVzcy5cbiAgICogQ3JlYXRlcyBhIG5ldyBtb3Rpb24gY29udHJvbGxlciBmb3IgdGhlIGNvbWJpbmF0aW9uIG9mIHByb2ZpbGUgYW5kIGhhbmRlZG5lc3MsIGFuZCBmaXJlcyBhblxuICAgKiBldmVudCB0byBzaWduYWwgdGhlIGNoYW5nZVxuICAgKiBAcGFyYW0ge29iamVjdH0gZXZlbnRcbiAgICovXG4gIG9uSGFuZGVkbmVzc0NoYW5nZSgpIHtcbiAgICBpZiAoIXRoaXMuZGlzYWJsZWQpIHtcbiAgICAgIHRoaXMuY3JlYXRlTW90aW9uQ29udHJvbGxlcigpO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIG1lcmdlSnNvblByb2ZpbGVzKCkge1xuICAgIGlmICh0aGlzLnJlZ2lzdHJ5SnNvbiAmJiB0aGlzLmFzc2V0SnNvbikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGhpcy5tZXJnZWRQcm9maWxlID0gbWVyZ2VQcm9maWxlKHRoaXMucmVnaXN0cnlKc29uLCB0aGlzLmFzc2V0SnNvbik7XG4gICAgICAgIHRoaXMuaGFuZGVkbmVzc1NlbGVjdG9yLnNldFNlbGVjdGVkUHJvZmlsZSh0aGlzLm1lcmdlZFByb2ZpbGUpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgRXJyb3JMb2dnaW5nLmxvZyhlcnJvcik7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIG9uUmVnaXN0cnlKc29uU2VsZWN0ZWQoKSB7XG4gICAgaWYgKCF0aGlzLmVsZW1lbnQuZGlzYWJsZWQpIHtcbiAgICAgIHRoaXMucmVnaXN0cnlKc29uID0gbnVsbDtcbiAgICAgIHRoaXMubWVyZ2VkUHJvZmlsZSA9IG51bGw7XG4gICAgICB0aGlzLmhhbmRlZG5lc3NTZWxlY3Rvci5jbGVhclNlbGVjdGVkUHJvZmlsZSgpO1xuICAgICAgaWYgKHRoaXMucmVnaXN0cnlKc29uU2VsZWN0b3IuZmlsZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBsb2FkTG9jYWxKc29uKHRoaXMucmVnaXN0cnlKc29uU2VsZWN0b3IuZmlsZXNbMF0pLnRoZW4oKHJlZ2lzdHJ5SnNvbikgPT4ge1xuICAgICAgICAgIC8vIFRPRE8gdmFsaWRhdGUgSlNPTlxuICAgICAgICAgIHRoaXMucmVnaXN0cnlKc29uID0gcmVnaXN0cnlKc29uO1xuICAgICAgICAgIHRoaXMubWVyZ2VKc29uUHJvZmlsZXMoKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25Bc3NldEpzb25TZWxlY3RlZCgpIHtcbiAgICBpZiAoIXRoaXMuZWxlbWVudC5kaXNhYmxlZCkge1xuICAgICAgdGhpcy5hc3NldEpzb24gPSBudWxsO1xuICAgICAgdGhpcy5tZXJnZWRQcm9maWxlID0gbnVsbDtcbiAgICAgIHRoaXMuaGFuZGVkbmVzc1NlbGVjdG9yLmNsZWFyU2VsZWN0ZWRQcm9maWxlKCk7XG4gICAgICBpZiAodGhpcy5hc3NldEpzb25TZWxlY3Rvci5maWxlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGxvYWRMb2NhbEpzb24odGhpcy5hc3NldEpzb25TZWxlY3Rvci5maWxlc1swXSkudGhlbigoYXNzZXRKc29uKSA9PiB7XG4gICAgICAgICAgY29uc3QgdmFsaWQgPSB0aGlzLnNjaGVtYVZhbGlkYXRvcihhc3NldEpzb24pO1xuICAgICAgICAgIGlmICghdmFsaWQpIHtcbiAgICAgICAgICAgIEVycm9yTG9nZ2luZy5sb2codGhpcy5zY2hlbWFWYWxpZGF0b3IuZXJyb3IpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmFzc2V0SnNvbiA9IGFzc2V0SnNvbjtcbiAgICAgICAgICAgIHRoaXMubWVyZ2VKc29uUHJvZmlsZXMoKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBIYW5kbGVzIGNoYW5nZXMgdG8gdGhlIHNldCBvZiBsb2NhbCBmaWxlcyBzZWxlY3RlZFxuICAgKi9cbiAgb25Bc3NldHNTZWxlY3RlZCgpIHtcbiAgICBpZiAoIXRoaXMuZWxlbWVudC5kaXNhYmxlZCkge1xuICAgICAgY29uc3QgZmlsZUxpc3QgPSBBcnJheS5mcm9tKHRoaXMuYXNzZXRzU2VsZWN0b3IuZmlsZXMpO1xuICAgICAgdGhpcy5hc3NldHMgPSBbXTtcbiAgICAgIGZpbGVMaXN0LmZvckVhY2goKGZpbGUpID0+IHtcbiAgICAgICAgdGhpcy5hc3NldHNbZmlsZS5uYW1lXSA9IHdpbmRvdy5VUkwuY3JlYXRlT2JqZWN0VVJMKGZpbGUpO1xuICAgICAgfSk7XG4gICAgICB0aGlzLmNyZWF0ZU1vdGlvbkNvbnRyb2xsZXIoKTtcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgTG9jYWxQcm9maWxlU2VsZWN0b3I7XG4iLCIvKiBlc2xpbnQtZGlzYWJsZSBpbXBvcnQvbm8tdW5yZXNvbHZlZCAqL1xuaW1wb3J0ICogYXMgVEhSRUUgZnJvbSAnLi90aHJlZS9idWlsZC90aHJlZS5tb2R1bGUuanMnO1xuaW1wb3J0IHsgR0xURkxvYWRlciB9IGZyb20gJy4vdGhyZWUvZXhhbXBsZXMvanNtL2xvYWRlcnMvR0xURkxvYWRlci5qcyc7XG5pbXBvcnQgeyBPcmJpdENvbnRyb2xzIH0gZnJvbSAnLi90aHJlZS9leGFtcGxlcy9qc20vY29udHJvbHMvT3JiaXRDb250cm9scy5qcyc7XG5pbXBvcnQgeyBDb25zdGFudHMgfSBmcm9tICcuL21vdGlvbi1jb250cm9sbGVycy5tb2R1bGUuanMnO1xuLyogZXNsaW50LWVuYWJsZSAqL1xuXG5pbXBvcnQgRXJyb3JMb2dnaW5nIGZyb20gJy4vZXJyb3JMb2dnaW5nLmpzJztcblxuY29uc3QgdGhyZWUgPSB7fTtcbmxldCBjYW52YXNQYXJlbnRFbGVtZW50O1xubGV0IGFjdGl2ZU1vZGVsO1xuXG4vKipcbiAqIEBkZXNjcmlwdGlvbiBBdHRhY2hlcyBhIHNtYWxsIGJsdWUgc3BoZXJlIHRvIHRoZSBwb2ludCByZXBvcnRlZCBhcyB0b3VjaGVkIG9uIGFsbCB0b3VjaHBhZHNcbiAqIEBwYXJhbSB7T2JqZWN0fSBtb2RlbCAtIFRoZSBtb2RlbCB0byBhZGQgZG90cyB0b1xuICogQHBhcmFtIHtPYmplY3R9IG1vdGlvbkNvbnRyb2xsZXIgLSBBIE1vdGlvbkNvbnRyb2xsZXIgdG8gYmUgZGlzcGxheWVkIGFuZCBhbmltYXRlZFxuICogQHBhcmFtIHtPYmplY3R9IHJvb3ROb2RlIC0gVGhlIHJvb3Qgbm9kZSBpbiB0aGUgYXNzZXQgdG8gYmUgYW5pbWF0ZWRcbiAqL1xuZnVuY3Rpb24gYWRkVG91Y2hEb3RzKHsgbW90aW9uQ29udHJvbGxlciwgcm9vdE5vZGUgfSkge1xuICBPYmplY3Qua2V5cyhtb3Rpb25Db250cm9sbGVyLmNvbXBvbmVudHMpLmZvckVhY2goKGNvbXBvbmVudElkKSA9PiB7XG4gICAgY29uc3QgY29tcG9uZW50ID0gbW90aW9uQ29udHJvbGxlci5jb21wb25lbnRzW2NvbXBvbmVudElkXTtcbiAgICAvLyBGaW5kIHRoZSB0b3VjaHBhZHNcbiAgICBpZiAoY29tcG9uZW50LnR5cGUgPT09IENvbnN0YW50cy5Db21wb25lbnRUeXBlLlRPVUNIUEFEKSB7XG4gICAgICAvLyBGaW5kIHRoZSBub2RlIHRvIGF0dGFjaCB0aGUgdG91Y2ggZG90LlxuICAgICAgY29uc3QgY29tcG9uZW50Um9vdCA9IHJvb3ROb2RlLmdldE9iamVjdEJ5TmFtZShjb21wb25lbnQucm9vdE5vZGVOYW1lLCB0cnVlKTtcblxuICAgICAgaWYgKCFjb21wb25lbnRSb290KSB7XG4gICAgICAgIEVycm9yTG9nZ2luZy5sb2coYENvdWxkIG5vdCBmaW5kIHJvb3Qgbm9kZSBvZiB0b3VjaHBhZCBjb21wb25lbnQgJHtjb21wb25lbnQucm9vdE5vZGVOYW1lfWApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHRvdWNoUG9pbnRSb290ID0gY29tcG9uZW50Um9vdC5nZXRPYmplY3RCeU5hbWUoY29tcG9uZW50LnRvdWNoUG9pbnROb2RlTmFtZSwgdHJ1ZSk7XG4gICAgICBpZiAoIXRvdWNoUG9pbnRSb290KSB7XG4gICAgICAgIEVycm9yTG9nZ2luZy5sb2coYENvdWxkIG5vdCBmaW5kIHRvdWNoIGRvdCwgJHtjb21wb25lbnQudG91Y2hQb2ludE5vZGVOYW1lfSwgaW4gdG91Y2hwYWQgY29tcG9uZW50ICR7Y29tcG9uZW50SWR9YCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBzcGhlcmVHZW9tZXRyeSA9IG5ldyBUSFJFRS5TcGhlcmVHZW9tZXRyeSgwLjAwMSk7XG4gICAgICAgIGNvbnN0IG1hdGVyaWFsID0gbmV3IFRIUkVFLk1lc2hCYXNpY01hdGVyaWFsKHsgY29sb3I6IDB4MDAwMEZGIH0pO1xuICAgICAgICBjb25zdCBzcGhlcmUgPSBuZXcgVEhSRUUuTWVzaChzcGhlcmVHZW9tZXRyeSwgbWF0ZXJpYWwpO1xuICAgICAgICB0b3VjaFBvaW50Um9vdC5hZGQoc3BoZXJlKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xufVxuXG4vKipcbiAqIEBkZXNjcmlwdGlvbiBXYWxrcyB0aGUgbW9kZWwncyB0cmVlIHRvIGZpbmQgdGhlIG5vZGVzIG5lZWRlZCB0byBhbmltYXRlIHRoZSBjb21wb25lbnRzIGFuZFxuICogc2F2ZXMgdGhlbSBmb3IgdXNlIGluIHRoZSBmcmFtZSBsb29wXG4gKiBAcGFyYW0ge09iamVjdH0gbW9kZWwgLSBUaGUgbW9kZWwgdG8gZmluZCBub2RlcyBpblxuICovXG5mdW5jdGlvbiBmaW5kTm9kZXMobW9kZWwpIHtcbiAgY29uc3Qgbm9kZXMgPSB7fTtcblxuICAvLyBMb29wIHRocm91Z2ggdGhlIGNvbXBvbmVudHMgYW5kIGZpbmQgdGhlIG5vZGVzIG5lZWRlZCBmb3IgZWFjaCBjb21wb25lbnRzJyB2aXN1YWwgcmVzcG9uc2VzXG4gIE9iamVjdC52YWx1ZXMobW9kZWwubW90aW9uQ29udHJvbGxlci5jb21wb25lbnRzKS5mb3JFYWNoKChjb21wb25lbnQpID0+IHtcbiAgICBjb25zdCBjb21wb25lbnRSb290Tm9kZSA9IG1vZGVsLnJvb3ROb2RlLmdldE9iamVjdEJ5TmFtZShjb21wb25lbnQucm9vdE5vZGVOYW1lLCB0cnVlKTtcbiAgICBjb25zdCBjb21wb25lbnROb2RlcyA9IHt9O1xuXG4gICAgLy8gSWYgdGhlIHJvb3Qgbm9kZSBjYW5ub3QgYmUgZm91bmQsIHNraXAgdGhpcyBjb21wb25lbnRcbiAgICBpZiAoIWNvbXBvbmVudFJvb3ROb2RlKSB7XG4gICAgICBFcnJvckxvZ2dpbmcubG9nKGBDb3VsZCBub3QgZmluZCByb290IG5vZGUgb2YgY29tcG9uZW50ICR7Y29tcG9uZW50LnJvb3ROb2RlTmFtZX1gKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBMb29wIHRocm91Z2ggYWxsIHRoZSB2aXN1YWwgcmVzcG9uc2VzIHRvIGJlIGFwcGxpZWQgdG8gdGhpcyBjb21wb25lbnRcbiAgICBPYmplY3QudmFsdWVzKGNvbXBvbmVudC52aXN1YWxSZXNwb25zZXMpLmZvckVhY2goKHZpc3VhbFJlc3BvbnNlKSA9PiB7XG4gICAgICBjb25zdCB2aXN1YWxSZXNwb25zZU5vZGVzID0ge307XG4gICAgICBjb25zdCB7IHJvb3ROb2RlTmFtZSwgdGFyZ2V0Tm9kZU5hbWUsIHByb3BlcnR5IH0gPSB2aXN1YWxSZXNwb25zZS5kZXNjcmlwdGlvbjtcblxuICAgICAgLy8gRmluZCB0aGUgbm9kZSBhdCB0aGUgdG9wIG9mIHRoZSB2aXN1YWxpemF0aW9uXG4gICAgICBpZiAocm9vdE5vZGVOYW1lID09PSBjb21wb25lbnQucm9vdCkge1xuICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLnJvb3ROb2RlID0gY29tcG9uZW50Um9vdE5vZGU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLnJvb3ROb2RlID0gY29tcG9uZW50Um9vdE5vZGUuZ2V0T2JqZWN0QnlOYW1lKHJvb3ROb2RlTmFtZSwgdHJ1ZSk7XG4gICAgICB9XG5cbiAgICAgIC8vIElmIHRoZSByb290IG5vZGUgY2Fubm90IGJlIGZvdW5kLCBza2lwIHRoaXMgYW5pbWF0aW9uXG4gICAgICBpZiAoIXZpc3VhbFJlc3BvbnNlTm9kZXMucm9vdE5vZGUpIHtcbiAgICAgICAgRXJyb3JMb2dnaW5nLmxvZyhgQ291bGQgbm90IGZpbmQgcm9vdCBub2RlIG9mIHZpc3VhbCByZXNwb25zZSBmb3IgJHtyb290Tm9kZU5hbWV9YCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8gRmluZCB0aGUgbm9kZSB0byBiZSBjaGFuZ2VkXG4gICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLnRhcmdldE5vZGUgPSB2aXN1YWxSZXNwb25zZU5vZGVzLnJvb3ROb2RlLmdldE9iamVjdEJ5TmFtZSh0YXJnZXROb2RlTmFtZSk7XG5cbiAgICAgIC8vIElmIGFuaW1hdGluZyBhIHRyYW5zZm9ybSwgZmluZCB0aGUgdHdvIG5vZGVzIHRvIGJlIGludGVycG9sYXRlZCBiZXR3ZWVuLlxuICAgICAgaWYgKHByb3BlcnR5ID09PSAndHJhbnNmb3JtJykge1xuICAgICAgICBjb25zdCB7IG1pbk5vZGVOYW1lLCBtYXhOb2RlTmFtZSB9ID0gdmlzdWFsUmVzcG9uc2UuZGVzY3JpcHRpb247XG4gICAgICAgIHZpc3VhbFJlc3BvbnNlTm9kZXMubWluTm9kZSA9IHZpc3VhbFJlc3BvbnNlTm9kZXMucm9vdE5vZGUuZ2V0T2JqZWN0QnlOYW1lKG1pbk5vZGVOYW1lKTtcbiAgICAgICAgdmlzdWFsUmVzcG9uc2VOb2Rlcy5tYXhOb2RlID0gdmlzdWFsUmVzcG9uc2VOb2Rlcy5yb290Tm9kZS5nZXRPYmplY3RCeU5hbWUobWF4Tm9kZU5hbWUpO1xuXG4gICAgICAgIC8vIElmIHRoZSBleHRlbnRzIGNhbm5vdCBiZSBmb3VuZCwgc2tpcCB0aGlzIGFuaW1hdGlvblxuICAgICAgICBpZiAoIXZpc3VhbFJlc3BvbnNlTm9kZXMubWluTm9kZSB8fCAhdmlzdWFsUmVzcG9uc2VOb2Rlcy5tYXhOb2RlKSB7XG4gICAgICAgICAgRXJyb3JMb2dnaW5nLmxvZyhgQ291bGQgbm90IGZpbmQgZXh0ZW50cyBub2RlcyBvZiB2aXN1YWwgcmVzcG9uc2UgZm9yICR7cm9vdE5vZGVOYW1lfWApO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBBZGQgdGhlIGFuaW1hdGlvbiB0byB0aGUgY29tcG9uZW50J3Mgbm9kZXMgZGljdGlvbmFyeVxuICAgICAgY29tcG9uZW50Tm9kZXNbcm9vdE5vZGVOYW1lXSA9IHZpc3VhbFJlc3BvbnNlTm9kZXM7XG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGhlIGNvbXBvbmVudCdzIGFuaW1hdGlvbnMgdG8gdGhlIGNvbnRyb2xsZXIncyBub2RlcyBkaWN0aW9uYXJ5XG4gICAgbm9kZXNbY29tcG9uZW50LmlkXSA9IGNvbXBvbmVudE5vZGVzO1xuICB9KTtcblxuICByZXR1cm4gbm9kZXM7XG59XG5cblxuZnVuY3Rpb24gY2xlYXIoKSB7XG4gIGlmIChhY3RpdmVNb2RlbCkge1xuICAgIC8vIFJlbW92ZSBhbnkgZXhpc3RpbmcgbW9kZWwgZnJvbSB0aGUgc2NlbmVcbiAgICB0aHJlZS5zY2VuZS5yZW1vdmUoYWN0aXZlTW9kZWwucm9vdE5vZGUpO1xuXG4gICAgLy8gU2V0IHRoZSBwYWdlIGVsZW1lbnQgd2l0aCBjb250cm9sbGVyIGRhdGEgZm9yIGRlYnVnZ2luZ1xuICAgIGNvbnN0IGRhdGFFbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2RhdGEnKTtcbiAgICBkYXRhRWxlbWVudC5pbm5lckhUTUwgPSAnJztcblxuICAgIGFjdGl2ZU1vZGVsID0gbnVsbDtcbiAgfVxuXG4gIEVycm9yTG9nZ2luZy5jbGVhcigpO1xufVxuLyoqXG4gKiBAZGVzY3JpcHRpb24gRXZlbnQgaGFuZGxlciBmb3Igd2luZG93IHJlc2l6aW5nLlxuICovXG5mdW5jdGlvbiBvblJlc2l6ZSgpIHtcbiAgY29uc3Qgd2lkdGggPSBjYW52YXNQYXJlbnRFbGVtZW50LmNsaWVudFdpZHRoO1xuICBjb25zdCBoZWlnaHQgPSBjYW52YXNQYXJlbnRFbGVtZW50LmNsaWVudEhlaWdodDtcbiAgdGhyZWUuY2FtZXJhLmFzcGVjdFJhdGlvID0gd2lkdGggLyBoZWlnaHQ7XG4gIHRocmVlLmNhbWVyYS51cGRhdGVQcm9qZWN0aW9uTWF0cml4KCk7XG4gIHRocmVlLnJlbmRlcmVyLnNldFNpemUod2lkdGgsIGhlaWdodCk7XG4gIHRocmVlLmNvbnRyb2xzLnVwZGF0ZSgpO1xufVxuXG4vKipcbiAqIEBkZXNjcmlwdGlvbiBDYWxsYmFjayB3aGljaCBydW5zIHRoZSByZW5kZXJpbmcgbG9vcC4gKFBhc3NlZCBpbnRvIHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUpXG4gKi9cbmZ1bmN0aW9uIGFuaW1hdGlvbkZyYW1lQ2FsbGJhY2soKSB7XG4gIHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUoYW5pbWF0aW9uRnJhbWVDYWxsYmFjayk7XG5cbiAgaWYgKGFjdGl2ZU1vZGVsKSB7XG4gICAgLy8gQ2F1c2UgdGhlIE1vdGlvbkNvbnRyb2xsZXIgdG8gcG9sbCB0aGUgR2FtZXBhZCBmb3IgZGF0YVxuICAgIGFjdGl2ZU1vZGVsLm1vdGlvbkNvbnRyb2xsZXIudXBkYXRlRnJvbUdhbWVwYWQoKTtcblxuICAgIC8vIFNldCB0aGUgcGFnZSBlbGVtZW50IHdpdGggY29udHJvbGxlciBkYXRhIGZvciBkZWJ1Z2dpbmdcbiAgICBjb25zdCBkYXRhRWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdkYXRhJyk7XG4gICAgZGF0YUVsZW1lbnQuaW5uZXJIVE1MID0gSlNPTi5zdHJpbmdpZnkoYWN0aXZlTW9kZWwubW90aW9uQ29udHJvbGxlci5kYXRhLCBudWxsLCAyKTtcblxuICAgIC8vIFVwZGF0ZSB0aGUgM0QgbW9kZWwgdG8gcmVmbGVjdCB0aGUgYnV0dG9uLCB0aHVtYnN0aWNrLCBhbmQgdG91Y2hwYWQgc3RhdGVcbiAgICBPYmplY3QudmFsdWVzKGFjdGl2ZU1vZGVsLm1vdGlvbkNvbnRyb2xsZXIuY29tcG9uZW50cykuZm9yRWFjaCgoY29tcG9uZW50KSA9PiB7XG4gICAgICBjb25zdCBjb21wb25lbnROb2RlcyA9IGFjdGl2ZU1vZGVsLm5vZGVzW2NvbXBvbmVudC5pZF07XG5cbiAgICAgIC8vIFNraXAgaWYgdGhlIGNvbXBvbmVudCBub2RlIGlzIG5vdCBmb3VuZC4gTm8gZXJyb3IgaXMgbmVlZGVkLCBiZWNhdXNlIGl0XG4gICAgICAvLyB3aWxsIGhhdmUgYmVlbiByZXBvcnRlZCBhdCBsb2FkIHRpbWUuXG4gICAgICBpZiAoIWNvbXBvbmVudE5vZGVzKSByZXR1cm47XG5cbiAgICAgIC8vIFVwZGF0ZSBub2RlIGRhdGEgYmFzZWQgb24gdGhlIHZpc3VhbCByZXNwb25zZXMnIGN1cnJlbnQgc3RhdGVzXG4gICAgICBPYmplY3QudmFsdWVzKGNvbXBvbmVudC52aXN1YWxSZXNwb25zZXMpLmZvckVhY2goKHZpc3VhbFJlc3BvbnNlKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgZGVzY3JpcHRpb24sIHZhbHVlIH0gPSB2aXN1YWxSZXNwb25zZTtcbiAgICAgICAgY29uc3QgdmlzdWFsUmVzcG9uc2VOb2RlcyA9IGNvbXBvbmVudE5vZGVzW2Rlc2NyaXB0aW9uLnJvb3ROb2RlTmFtZV07XG5cbiAgICAgICAgLy8gU2tpcCBpZiB0aGUgdmlzdWFsIHJlc3BvbnNlIG5vZGUgaXMgbm90IGZvdW5kLiBObyBlcnJvciBpcyBuZWVkZWQsXG4gICAgICAgIC8vIGJlY2F1c2UgaXQgd2lsbCBoYXZlIGJlZW4gcmVwb3J0ZWQgYXQgbG9hZCB0aW1lLlxuICAgICAgICBpZiAoIXZpc3VhbFJlc3BvbnNlTm9kZXMpIHJldHVybjtcblxuICAgICAgICAvLyBDYWxjdWxhdGUgdGhlIG5ldyBwcm9wZXJ0aWVzIGJhc2VkIG9uIHRoZSB3ZWlnaHQgc3VwcGxpZWRcbiAgICAgICAgaWYgKGRlc2NyaXB0aW9uLnByb3BlcnR5ID09PSAndmlzaWJpbGl0eScpIHtcbiAgICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLnRhcmdldE5vZGUudmlzaWJsZSA9IHZhbHVlO1xuICAgICAgICB9IGVsc2UgaWYgKGRlc2NyaXB0aW9uLnByb3BlcnR5ID09PSAndHJhbnNmb3JtJykge1xuICAgICAgICAgIFRIUkVFLlF1YXRlcm5pb24uc2xlcnAoXG4gICAgICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLm1pbk5vZGUucXVhdGVybmlvbixcbiAgICAgICAgICAgIHZpc3VhbFJlc3BvbnNlTm9kZXMubWF4Tm9kZS5xdWF0ZXJuaW9uLFxuICAgICAgICAgICAgdmlzdWFsUmVzcG9uc2VOb2Rlcy50YXJnZXROb2RlLnF1YXRlcm5pb24sXG4gICAgICAgICAgICB2YWx1ZVxuICAgICAgICAgICk7XG5cbiAgICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLnRhcmdldE5vZGUucG9zaXRpb24ubGVycFZlY3RvcnMoXG4gICAgICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLm1pbk5vZGUucG9zaXRpb24sXG4gICAgICAgICAgICB2aXN1YWxSZXNwb25zZU5vZGVzLm1heE5vZGUucG9zaXRpb24sXG4gICAgICAgICAgICB2YWx1ZVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgdGhyZWUucmVuZGVyZXIucmVuZGVyKHRocmVlLnNjZW5lLCB0aHJlZS5jYW1lcmEpO1xuICB0aHJlZS5jb250cm9scy51cGRhdGUoKTtcbn1cblxuY29uc3QgTW9kZWxWaWV3ZXIgPSB7XG4gIGluaXRpYWxpemU6ICgpID0+IHtcbiAgICBjYW52YXNQYXJlbnRFbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21vZGVsVmlld2VyJyk7XG4gICAgY29uc3Qgd2lkdGggPSBjYW52YXNQYXJlbnRFbGVtZW50LmNsaWVudFdpZHRoO1xuICAgIGNvbnN0IGhlaWdodCA9IGNhbnZhc1BhcmVudEVsZW1lbnQuY2xpZW50SGVpZ2h0O1xuXG4gICAgLy8gU2V0IHVwIHRoZSBUSFJFRS5qcyBpbmZyYXN0cnVjdHVyZVxuICAgIHRocmVlLmNhbWVyYSA9IG5ldyBUSFJFRS5QZXJzcGVjdGl2ZUNhbWVyYSg3NSwgd2lkdGggLyBoZWlnaHQsIDAuMDEsIDEwMDApO1xuICAgIHRocmVlLmNhbWVyYS5wb3NpdGlvbi55ID0gMC41O1xuICAgIHRocmVlLnNjZW5lID0gbmV3IFRIUkVFLlNjZW5lKCk7XG4gICAgdGhyZWUuc2NlbmUuYmFja2dyb3VuZCA9IG5ldyBUSFJFRS5Db2xvcigweDAwYWE0NCk7XG4gICAgdGhyZWUucmVuZGVyZXIgPSBuZXcgVEhSRUUuV2ViR0xSZW5kZXJlcih7IGFudGlhbGlhczogdHJ1ZSB9KTtcbiAgICB0aHJlZS5yZW5kZXJlci5zZXRTaXplKHdpZHRoLCBoZWlnaHQpO1xuICAgIHRocmVlLnJlbmRlcmVyLmdhbW1hT3V0cHV0ID0gdHJ1ZTtcbiAgICB0aHJlZS5sb2FkZXIgPSBuZXcgR0xURkxvYWRlcigpO1xuXG4gICAgLy8gU2V0IHVwIHRoZSBjb250cm9scyBmb3IgbW92aW5nIHRoZSBzY2VuZSBhcm91bmRcbiAgICB0aHJlZS5jb250cm9scyA9IG5ldyBPcmJpdENvbnRyb2xzKHRocmVlLmNhbWVyYSwgdGhyZWUucmVuZGVyZXIuZG9tRWxlbWVudCk7XG4gICAgdGhyZWUuY29udHJvbHMuZW5hYmxlRGFtcGluZyA9IHRydWU7XG4gICAgdGhyZWUuY29udHJvbHMubWluRGlzdGFuY2UgPSAwLjA1O1xuICAgIHRocmVlLmNvbnRyb2xzLm1heERpc3RhbmNlID0gMC4zO1xuICAgIHRocmVlLmNvbnRyb2xzLmVuYWJsZVBhbiA9IGZhbHNlO1xuICAgIHRocmVlLmNvbnRyb2xzLnVwZGF0ZSgpO1xuXG4gICAgLy8gU2V0IHVwIHRoZSBsaWdodHMgc28gdGhlIG1vZGVsIGNhbiBiZSBzZWVuXG4gICAgY29uc3QgYm90dG9tRGlyZWN0aW9uYWxMaWdodCA9IG5ldyBUSFJFRS5EaXJlY3Rpb25hbExpZ2h0KDB4RkZGRkZGLCAyKTtcbiAgICBib3R0b21EaXJlY3Rpb25hbExpZ2h0LnBvc2l0aW9uLnNldCgwLCAtMSwgMCk7XG4gICAgdGhyZWUuc2NlbmUuYWRkKGJvdHRvbURpcmVjdGlvbmFsTGlnaHQpO1xuICAgIGNvbnN0IHRvcERpcmVjdGlvbmFsTGlnaHQgPSBuZXcgVEhSRUUuRGlyZWN0aW9uYWxMaWdodCgweEZGRkZGRiwgMik7XG4gICAgdGhyZWUuc2NlbmUuYWRkKHRvcERpcmVjdGlvbmFsTGlnaHQpO1xuXG4gICAgLy8gQWRkIHRoZSBUSFJFRS5qcyBjYW52YXMgdG8gdGhlIHBhZ2VcbiAgICBjYW52YXNQYXJlbnRFbGVtZW50LmFwcGVuZENoaWxkKHRocmVlLnJlbmRlcmVyLmRvbUVsZW1lbnQpO1xuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdyZXNpemUnLCBvblJlc2l6ZSwgZmFsc2UpO1xuXG4gICAgLy8gU3RhcnQgcHVtcGluZyBmcmFtZXNcbiAgICB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKGFuaW1hdGlvbkZyYW1lQ2FsbGJhY2spO1xuICB9LFxuXG4gIGxvYWRNb2RlbDogYXN5bmMgKG1vdGlvbkNvbnRyb2xsZXIpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZ2x0ZkFzc2V0ID0gYXdhaXQgbmV3IFByb21pc2UoKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgdGhyZWUubG9hZGVyLmxvYWQoXG4gICAgICAgICAgbW90aW9uQ29udHJvbGxlci5hc3NldFVybCxcbiAgICAgICAgICAobG9hZGVkQXNzZXQpID0+IHsgcmVzb2x2ZShsb2FkZWRBc3NldCk7IH0sXG4gICAgICAgICAgbnVsbCxcbiAgICAgICAgICAoKSA9PiB7IHJlamVjdChuZXcgRXJyb3IoYEFzc2V0ICR7bW90aW9uQ29udHJvbGxlci5hc3NldFVybH0gbWlzc2luZyBvciBtYWxmb3JtZWQuYCkpOyB9XG4gICAgICAgICk7XG4gICAgICB9KSk7XG5cbiAgICAgIC8vIFJlbW92ZSBhbnkgZXhpc3RpbmcgbW9kZWwgZnJvbSB0aGUgc2NlbmVcbiAgICAgIGNsZWFyKCk7XG5cbiAgICAgIGNvbnN0IG1vZGVsID0ge1xuICAgICAgICBtb3Rpb25Db250cm9sbGVyLFxuICAgICAgICByb290Tm9kZTogZ2x0ZkFzc2V0LnNjZW5lXG4gICAgICB9O1xuXG4gICAgICBtb2RlbC5ub2RlcyA9IGZpbmROb2Rlcyhtb2RlbCk7XG4gICAgICBhZGRUb3VjaERvdHMobW9kZWwpO1xuXG4gICAgICAvLyBTZXQgdGhlIG5ldyBtb2RlbFxuICAgICAgYWN0aXZlTW9kZWwgPSBtb2RlbDtcbiAgICAgIHRocmVlLnNjZW5lLmFkZChhY3RpdmVNb2RlbC5yb290Tm9kZSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIEVycm9yTG9nZ2luZy50aHJvdyhlcnJvcik7XG4gICAgfVxuICB9LFxuXG4gIGNsZWFyXG59O1xuXG5leHBvcnQgZGVmYXVsdCBNb2RlbFZpZXdlcjtcbiIsImxldCBjb250cm9sc0xpc3RFbGVtZW50O1xubGV0IG1vY2tHYW1lcGFkO1xuXG5mdW5jdGlvbiBvbkJ1dHRvblRvdWNoZWQoZXZlbnQpIHtcbiAgY29uc3QgeyBpbmRleCB9ID0gZXZlbnQudGFyZ2V0LmRhdGFzZXQ7XG4gIG1vY2tHYW1lcGFkLmJ1dHRvbnNbaW5kZXhdLnRvdWNoZWQgPSBldmVudC50YXJnZXQuY2hlY2tlZDtcbn1cblxuZnVuY3Rpb24gb25CdXR0b25QcmVzc2VkKGV2ZW50KSB7XG4gIGNvbnN0IHsgaW5kZXggfSA9IGV2ZW50LnRhcmdldC5kYXRhc2V0O1xuICBtb2NrR2FtZXBhZC5idXR0b25zW2luZGV4XS5wcmVzc2VkID0gZXZlbnQudGFyZ2V0LmNoZWNrZWQ7XG59XG5cbmZ1bmN0aW9uIG9uQnV0dG9uVmFsdWVDaGFuZ2UoZXZlbnQpIHtcbiAgY29uc3QgeyBpbmRleCB9ID0gZXZlbnQudGFyZ2V0LmRhdGFzZXQ7XG4gIG1vY2tHYW1lcGFkLmJ1dHRvbnNbaW5kZXhdLnZhbHVlID0gTnVtYmVyKGV2ZW50LnRhcmdldC52YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIG9uQXhpc1ZhbHVlQ2hhbmdlKGV2ZW50KSB7XG4gIGNvbnN0IHsgaW5kZXggfSA9IGV2ZW50LnRhcmdldC5kYXRhc2V0O1xuICBtb2NrR2FtZXBhZC5heGVzW2luZGV4XSA9IE51bWJlcihldmVudC50YXJnZXQudmFsdWUpO1xufVxuXG5mdW5jdGlvbiBjbGVhcigpIHtcbiAgaWYgKCFjb250cm9sc0xpc3RFbGVtZW50KSB7XG4gICAgY29udHJvbHNMaXN0RWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb250cm9sc0xpc3QnKTtcbiAgfVxuICBjb250cm9sc0xpc3RFbGVtZW50LmlubmVySFRNTCA9ICcnO1xuICBtb2NrR2FtZXBhZCA9IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gYnVpbGQobW90aW9uQ29udHJvbGxlcikge1xuICBjbGVhcigpO1xuXG4gIG1vY2tHYW1lcGFkID0gbW90aW9uQ29udHJvbGxlci54cklucHV0U291cmNlLmdhbWVwYWQ7XG5cbiAgT2JqZWN0LnZhbHVlcyhtb3Rpb25Db250cm9sbGVyLmNvbXBvbmVudHMpLmZvckVhY2goKGNvbXBvbmVudCkgPT4ge1xuICAgIGNvbnN0IHsgYnV0dG9uLCB4QXhpcywgeUF4aXMgfSA9IGNvbXBvbmVudC5kZXNjcmlwdGlvbi5nYW1lcGFkSW5kaWNlcztcblxuICAgIGxldCBpbm5lckh0bWwgPSBgXG4gICAgICA8aDQ+Q29tcG9uZW50ICR7Y29tcG9uZW50LmlkfTwvaDQ+XG4gICAgYDtcblxuICAgIGlmIChidXR0b24gIT09IHVuZGVmaW5lZCkge1xuICAgICAgaW5uZXJIdG1sICs9IGBcbiAgICAgIDxsYWJlbD5idXR0b25WYWx1ZTxsYWJlbD5cbiAgICAgIDxpbnB1dCBpZD1cImJ1dHRvblZhbHVlJHtidXR0b259XCIgZGF0YS1pbmRleD1cIiR7YnV0dG9ufVwiIHR5cGU9XCJyYW5nZVwiIG1pbj1cIjBcIiBtYXg9XCIxXCIgc3RlcD1cIjAuMDFcIiB2YWx1ZT1cIjBcIj5cbiAgICAgIFxuICAgICAgPGxhYmVsPnRvdWNoZWQ8L2xhYmVsPlxuICAgICAgPGlucHV0IGlkPVwiYnV0dG9uVG91Y2hlZCR7YnV0dG9ufVwiIGRhdGEtaW5kZXg9XCIke2J1dHRvbn1cIiB0eXBlPVwiY2hlY2tib3hcIj5cblxuICAgICAgPGxhYmVsPnByZXNzZWQ8L2xhYmVsPlxuICAgICAgPGlucHV0IGlkPVwiYnV0dG9uUHJlc3NlZCR7YnV0dG9ufVwiIGRhdGEtaW5kZXg9XCIke2J1dHRvbn1cIiB0eXBlPVwiY2hlY2tib3hcIj5cbiAgICAgIGA7XG4gICAgfVxuXG4gICAgaWYgKHhBeGlzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlubmVySHRtbCArPSBgXG4gICAgICA8YnIvPlxuICAgICAgPGxhYmVsPnhBeGlzPGxhYmVsPlxuICAgICAgPGlucHV0IGlkPVwiYXhpcyR7eEF4aXN9XCIgZGF0YS1pbmRleD1cIiR7eEF4aXN9XCJcbiAgICAgICAgICAgICB0eXBlPVwicmFuZ2VcIiBtaW49XCItMVwiIG1heD1cIjFcIiBzdGVwPVwiMC4wMVwiIHZhbHVlPVwiMFwiPlxuICAgICAgYDtcbiAgICB9XG5cbiAgICBpZiAoeUF4aXMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaW5uZXJIdG1sICs9IGBcbiAgICAgICAgPGxhYmVsPnlBeGlzPGxhYmVsPlxuICAgICAgICA8aW5wdXQgaWQ9XCJheGlzJHt5QXhpc31cIiBkYXRhLWluZGV4PVwiJHt5QXhpc31cIlxuICAgICAgICAgICAgICB0eXBlPVwicmFuZ2VcIiBtaW49XCItMVwiIG1heD1cIjFcIiBzdGVwPVwiMC4wMVwiIHZhbHVlPVwiMFwiPlxuICAgICAgYDtcbiAgICB9XG5cbiAgICBjb25zdCBsaXN0RWxlbWVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xpJyk7XG4gICAgbGlzdEVsZW1lbnQuc2V0QXR0cmlidXRlKCdjbGFzcycsICdjb21wb25lbnQnKTtcbiAgICBsaXN0RWxlbWVudC5pbm5lckhUTUwgPSBpbm5lckh0bWw7XG4gICAgY29udHJvbHNMaXN0RWxlbWVudC5hcHBlbmRDaGlsZChsaXN0RWxlbWVudCk7XG5cbiAgICBpZiAoYnV0dG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGBidXR0b25WYWx1ZSR7YnV0dG9ufWApLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0Jywgb25CdXR0b25WYWx1ZUNoYW5nZSk7XG4gICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChgYnV0dG9uVG91Y2hlZCR7YnV0dG9ufWApLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgb25CdXR0b25Ub3VjaGVkKTtcbiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGBidXR0b25QcmVzc2VkJHtidXR0b259YCkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBvbkJ1dHRvblByZXNzZWQpO1xuICAgIH1cblxuICAgIGlmICh4QXhpcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChgYXhpcyR7eEF4aXN9YCkuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCBvbkF4aXNWYWx1ZUNoYW5nZSk7XG4gICAgfVxuXG4gICAgaWYgKHlBeGlzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGBheGlzJHt5QXhpc31gKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIG9uQXhpc1ZhbHVlQ2hhbmdlKTtcbiAgICB9XG4gIH0pO1xufVxuXG5leHBvcnQgZGVmYXVsdCB7IGNsZWFyLCBidWlsZCB9O1xuIiwiaW1wb3J0IFJlcG9zaXRvcnlTZWxlY3RvciBmcm9tICcuL3JlcG9zaXRvcnlTZWxlY3Rvci5qcyc7XG5pbXBvcnQgTG9jYWxQcm9maWxlU2VsZWN0b3IgZnJvbSAnLi9sb2NhbFByb2ZpbGVTZWxlY3Rvci5qcyc7XG5pbXBvcnQgTW9kZWxWaWV3ZXIgZnJvbSAnLi9tb2RlbFZpZXdlci5qcyc7XG5pbXBvcnQgTWFudWFsQ29udHJvbHMgZnJvbSAnLi9tYW51YWxDb250cm9scy5qcyc7XG5pbXBvcnQgRXJyb3JMb2dnaW5nIGZyb20gJy4vZXJyb3JMb2dnaW5nLmpzJztcblxuY29uc3Qgc2VsZWN0b3JJZFN0b3JhZ2VLZXkgPSAnc2VsZWN0b3JJZCc7XG5jb25zdCBzZWxlY3RvcnMgPSB7fTtcbmxldCBhY3RpdmVTZWxlY3RvcjtcblxuLyoqXG4gKiBVcGRhdGVzIHRoZSBjb250cm9scyBhbmQgbW9kZWwgdmlld2VyIHdoZW4gdGhlIHNlbGVjdGVkIG1vdGlvbiBjb250cm9sbGVyIGNoYW5nZXNcbiAqIEBwYXJhbSB7T2JqZWN0fSBldmVudFxuICovXG5mdW5jdGlvbiBvbk1vdGlvbkNvbnRyb2xsZXJDaGFuZ2UoZXZlbnQpIHtcbiAgaWYgKGV2ZW50LnRhcmdldCA9PT0gYWN0aXZlU2VsZWN0b3IuZWxlbWVudCkge1xuICAgIEVycm9yTG9nZ2luZy5jbGVhckFsbCgpO1xuICAgIGlmICghZXZlbnQuZGV0YWlsKSB7XG4gICAgICBNb2RlbFZpZXdlci5jbGVhcigpO1xuICAgICAgTWFudWFsQ29udHJvbHMuY2xlYXIoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgbW90aW9uQ29udHJvbGxlciA9IGV2ZW50LmRldGFpbDtcbiAgICAgIE1hbnVhbENvbnRyb2xzLmJ1aWxkKG1vdGlvbkNvbnRyb2xsZXIpO1xuICAgICAgTW9kZWxWaWV3ZXIubG9hZE1vZGVsKG1vdGlvbkNvbnRyb2xsZXIpO1xuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIEhhbmRsZXMgdGhlIHNlbGVjdGlvbiBzb3VyY2UgcmFkaW8gYnV0dG9uIGNoYW5nZVxuICovXG5mdW5jdGlvbiBvblJhZGlvQ2hhbmdlKCkge1xuICBNYW51YWxDb250cm9scy5jbGVhcigpO1xuICBNb2RlbFZpZXdlci5jbGVhcigpO1xuXG4gIC8vIEZpZ3VyZSBvdXQgd2hpY2ggaXRlbSBpcyBub3cgc2VsZWN0ZWRcbiAgY29uc3Qgc2VsZWN0ZWRRdWVyeSA9ICdpbnB1dFtuYW1lID0gXCJzb3VyY2VTZWxlY3RvclwiXTpjaGVja2VkJztcbiAgY29uc3Qgc2VsZWN0b3JUeXBlID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWxlY3RlZFF1ZXJ5KS52YWx1ZTtcblxuICAvLyBEaXNhYmxlIHRoZSBwcmV2aW91cyBzZWxlY3Rpb24gc291cmNlXG4gIGlmIChhY3RpdmVTZWxlY3Rvcikge1xuICAgIGFjdGl2ZVNlbGVjdG9yLmRpc2FibGUoKTtcbiAgfVxuXG4gIC8vIFN0YXJ0IHVzaW5nIHRoZSBuZXcgc2VsZWN0aW9uIHNvdXJjZVxuICBhY3RpdmVTZWxlY3RvciA9IHNlbGVjdG9yc1tzZWxlY3RvclR5cGVdO1xuICBhY3RpdmVTZWxlY3Rvci5lbmFibGUoKTtcbiAgd2luZG93LmxvY2FsU3RvcmFnZS5zZXRJdGVtKHNlbGVjdG9ySWRTdG9yYWdlS2V5LCBzZWxlY3RvclR5cGUpO1xufVxuXG5mdW5jdGlvbiBvbkxvYWQoKSB7XG4gIE1vZGVsVmlld2VyLmluaXRpYWxpemUoKTtcblxuICAvLyBIb29rIHVwIGV2ZW50IGxpc3RlbmVycyB0byB0aGUgcmFkaW8gYnV0dG9uc1xuICBjb25zdCByZXBvc2l0b3J5UmFkaW9CdXR0b24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVwb3NpdG9yeVJhZGlvQnV0dG9uJyk7XG4gIGNvbnN0IGxvY2FsUHJvZmlsZVJhZGlvQnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvY2FsUHJvZmlsZVJhZGlvQnV0dG9uJyk7XG4gIHJlcG9zaXRvcnlSYWRpb0J1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBvblJhZGlvQ2hhbmdlKTtcbiAgbG9jYWxQcm9maWxlUmFkaW9CdXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgb25SYWRpb0NoYW5nZSk7XG5cbiAgLy8gQ2hlY2sgaWYgdGhlIHBhZ2UgaGFzIHN0b3JlZCBhIGNob2ljZSBvZiBzZWxlY3Rpb24gc291cmNlXG4gIGNvbnN0IHN0b3JlZFNlbGVjdG9ySWQgPSB3aW5kb3cubG9jYWxTdG9yYWdlLmdldEl0ZW0oc2VsZWN0b3JJZFN0b3JhZ2VLZXkpO1xuICBjb25zdCByYWRpb0J1dHRvblRvU2VsZWN0ID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihgaW5wdXRbdmFsdWUgPSBcIiR7c3RvcmVkU2VsZWN0b3JJZH1cIl1gKTtcbiAgaWYgKHJhZGlvQnV0dG9uVG9TZWxlY3QpIHtcbiAgICByYWRpb0J1dHRvblRvU2VsZWN0LmNoZWNrZWQgPSB0cnVlO1xuICB9XG5cbiAgLy8gQ3JlYXRlIHRoZSBvYmplY3RzIHRvIHNlbGVjdCBtb3Rpb24gY29udHJvbGxlcnMgYmFzZWQgb24gdXNlciBpbnB1dFxuICBzZWxlY3RvcnMucmVwb3NpdG9yeSA9IG5ldyBSZXBvc2l0b3J5U2VsZWN0b3IoKTtcbiAgc2VsZWN0b3JzLmxvY2FsUHJvZmlsZSA9IG5ldyBMb2NhbFByb2ZpbGVTZWxlY3RvcigpO1xuICBPYmplY3QudmFsdWVzKHNlbGVjdG9ycykuZm9yRWFjaCgoc2VsZWN0b3IpID0+IHtcbiAgICBzZWxlY3Rvci5lbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ21vdGlvbkNvbnRyb2xsZXJDaGFuZ2UnLCBvbk1vdGlvbkNvbnRyb2xsZXJDaGFuZ2UpO1xuICB9KTtcblxuICAvLyBtYW51YWxseSB0cmlnZ2VyIGZpcnN0IGNoZWNrXG4gIG9uUmFkaW9DaGFuZ2UoKTtcbn1cbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdsb2FkJywgb25Mb2FkKTtcbiJdLCJuYW1lcyI6WyJUSFJFRS5TcGhlcmVHZW9tZXRyeSIsIlRIUkVFLk1lc2hCYXNpY01hdGVyaWFsIiwiVEhSRUUuTWVzaCIsIlRIUkVFLlF1YXRlcm5pb24iLCJUSFJFRS5QZXJzcGVjdGl2ZUNhbWVyYSIsIlRIUkVFLlNjZW5lIiwiVEhSRUUuQ29sb3IiLCJUSFJFRS5XZWJHTFJlbmRlcmVyIiwiVEhSRUUuRGlyZWN0aW9uYWxMaWdodCIsImNsZWFyIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQUE7OztBQUdBLE1BQU0sV0FBVyxDQUFDOzs7Ozs7RUFNaEIsV0FBVyxDQUFDLGtCQUFrQixFQUFFLFVBQVUsRUFBRTtJQUMxQyxJQUFJLENBQUMsa0JBQWtCLEVBQUU7TUFDdkIsTUFBTSxJQUFJLEtBQUssQ0FBQyxnQ0FBZ0MsQ0FBQyxDQUFDO0tBQ25EOztJQUVELElBQUksQ0FBQyxVQUFVLEVBQUU7TUFDZixNQUFNLElBQUksS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7S0FDM0M7O0lBRUQsSUFBSSxDQUFDLEVBQUUsR0FBRyxrQkFBa0IsQ0FBQyxTQUFT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
