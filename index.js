/**
 * @module @funhouse-atelier/sails-hook-orm-mongoose
 * @desc Loads and instantiates model files as Mongoose models.
 */

/**
 * Module dependencies
 */
 var mongoose = require('mongoose');

 /**
  * Module exports
  * @param  {SailsApp} sails
  * @return {Dictionary}
  */
 module.exports = function (sails) {
 
   /**
    * Hook definition
    */
   return {
 
 
     /**
      * defaults
      *
      * The implicit configuration defaults merged into `sails.config` by this hook.
      *
      * @type {Dictionary}
      */
     defaults: {
 
       globals: {
         models: true
       },
 
       // Mongoose-specific config
       mongoose: {
 
         // The default Mongo connection URI to use when communicating with the Mongo database for every one of
         // this app's models. By default, uses the database: "my_sails_app"
         // For more about the connection string, see: https://docs.mongodb.org/manual/reference/connection-string/
         uri: sails.config.custom.mongo.connectionUri,
 
         // These optional connection options are passed in to mongoose when `.connect()` is called.
         // See http://mongoosejs.com/docs/connections.html for a full list of available options.
         connectionOpts: {
           useNewUrlParser:     true,
           useUnifiedTopology:	true,
           useCreateIndex:      true,
         }
 
       }
 
     },
 
 
 
     /**
      * configure()
      *
      * @type {Function}
      */
     configure: function() {
 
       // Validate `sails.config.globals.models`
       if (typeof sails.config.globals === 'object' && typeof sails.config.globals.models !== 'boolean') {
         throw new Error(
           'If provided, `sails.config.globals.models` must be either `true` or `false`.\n'+
           'If `true`, instantiated Mongoose models will be exposed as global variables.'
         );
       }
 
       // Validate `sails.config.mongoose.uri`
       if ( typeof sails.config.mongoose.uri !== 'string') {
         throw new Error(
           'Expected Mongo connection URI (a string) to be provided as `sails.config.mongoose.uri`, but the provided Mongo URI is invalid.\n'+
           'See https://docs.mongodb.org/manual/reference/connection-string/ for help.'
         );
       }
 
       // Validate `sails.config.mongoose.connectionOpts`
       if ( typeof sails.config.mongoose.connectionOpts !== 'object' || Array.isArray(sails.config.mongoose.connectionOpts)) {
         throw new Error(
           'If provided, `sails.config.mongoose.connectionOpts` must be a dictionary of additional options to pass to Mongoose.\n'+
           'See http://mongoosejs.com/docs/connections.html for a full list of available options.'
         );
       }
 
     },
 
 
 
     /**
      * initialize()
      *
      * @param  {Function} _cb
      */
     initialize: async function(_cb) {
 
       // Wrap the actual `initialize` callback with a function which uses a flag to track whether or not we've already called our callback.
       // This prevents the `initialize` callback from being called more than once.
       // (^^ TODO for mike: consider pulling this into Sails' core hook loader)
       //
       // (In this case, we need this because we're binding event handlers to the mongoose connection that could fire at any time)
       var hasAlreadyTriggeredCallback;
       var cb = function (err){
         if (hasAlreadyTriggeredCallback) {
           if (err) {
             // If the callback is being triggered again with an error, we have no choice but to throw and crash the server.
             // (anything else would leave the hook and app in a weird halfway-consistent state and could cause far worse problems; including jeopardizing your data)
             sails.log.error('`initialize` function of Mongoose hook (ORM hook override) was called again, but that should never happen more than once!');
             sails.log.error('Proceeding to crash the server... (this is to avoid creating any weird race conditions that could potentially mess up your data)');
             throw err;
           }
           else { sails.log.warn('`initialize` function of Mongoose hook (ORM hook override) was called again, but that should never happen more than once!'); }
           return;
         }
         hasAlreadyTriggeredCallback = true;
         return _cb(err);
       };
 
       try {
         // Expose `sails.mongoose`.
         // (note that it's important to do this _before_ the other stuff below so that it is accessible for use in custom
         //  `constructSchema` interceptor functions, in case any of those are being used)
         sails.mongoose = mongoose;
 
         // connect to the MongoDB database, using the credentials stored in sails.config
         await sails.mongoose.connect(
           sails.config.mongoose.uri, 
           sails.config.mongoose.connectionOpts
         )
         .then(() => {
           sails.log.info('Connected to MongoDB database');
         })
         .catch(err => {
           sails.log.error('Failed to connect to MongoDB database');
           throw new Error(err.message);
         });
 
         // Load model definitions using the module loader.
         // Returned `modules` are case-insensitive, using filename to determine identity.
         // (This calls out to the `moduleloader` hook, which uses `sails-build-dictionary` and `includeall`
         //  to `require` and collate the relevant code for these modules-- also adding the appropriate `globalId`
         //  property.)
         sails.log.verbose('Loading the app\'s models from `%s`...', sails.config.paths.models);
         sails.modules.loadModels(function modulesLoaded(err, modules) {
          if (err) return cb(err);
 
          try {

            // Instantiate Mongoose schemas for each model definition (running custom `constructSchema` functions if provided)
            let schemas = {};
            for (const identity in modules) {
              
              let def = modules[identity];
              
              // Validate `schema` from model def (if omitted, default it to `{}`)
              if ( typeof def.schema === 'undefined') {
                def.schema = {};
              }
              if ( typeof def.schema !== 'object' || Array.isArray(def.schema) ) {
                throw new Error('Invalid `schema` provided in model (`'+identity+'`).  If provided, `schema` must be a dictionary.');
              }

              // If no `constructSchema` interceptor function was provided, just new up a Mongoose Schema by passing in `schema` from the model def.
              if ( typeof def.constructSchema === 'undefined' ) {
                schemas[identity] = new sails.mongoose.Schema(def.schema);
              }

              // If `constructSchema` interceptor function WAS provided, run it to get the Schema instance.
              else if ( typeof def.constructSchema === 'function' ) {
                try {
                  schemas[identity] = def.constructSchema(def.schema, sails);
                }
                catch (e) {
                  e.message = 'Encountered an error when running `constructSchema` interceptor provided for model (`'+identity+'`). Details:\n' + e.message;
                  e.stack = 'Encountered an error when running `constructSchema` interceptor provided for model (`'+identity+'`). Details:\n' + e.stack;
                  throw e;
                }
              }
              else {
                throw new Error('Invalid `constructSchema` interceptor provided in model (`'+identity+'`).  If provided, `constructSchema` must be a function.');
              }
            }

            // Now generate Model constructors from those schemas and expose references to them as `sails.models[identity]`.
            //
            // We also set `globalId` and `identity` directly on each Mongoose model.
            // (this is for consistency with the standard ORM hook, and improved compatibility with any code in other
            //  community hooks which relies on these properties existing)
            // Set `globalId` and `identity` directly on the Mongoose model
            sails.models = {};

            for (const identity in schemas) {
              sails.models[identity] = 
                sails.mongoose.model(modules[identity].globalId, schemas[identity])
              ;
              sails.models[identity].globalId = modules[identity].globalId;
              sails.models[identity].identity = identity;
            }
 
            // If configured to do so, also expose instantiated models as global variables.
            // (using `globalId` to expose these models process-wide)
            if (
              typeof sails.config.globals === 'object' &&
              sails.config.globals.models
            ) {
              for (const identity in sails.models) {
                const Model = sails.models[identity];
                
                // Expose the Model as a global variable.
                global[Model.globalId] = Model;
              }
            }
 
            // At this point, we know Mongoose has connected to the database, everything is ready to go, and we can safely trigger `initialize`'s callback.
            return cb();
           }//</try>
           // If anything unexpected happened, pass the error to `initialize`'s callback.
           catch (e) {
             return cb(e);
           }//</try>
         });//</sails.modules.loadModels>
 
       }
       // If anything unexpected happened, pass the error to `initialize`'s callback.
       catch (e) {
         return cb(e);
       }
     },//</initialize>
 
 
   };//</return hook definition>
 };//</module.exports>
 